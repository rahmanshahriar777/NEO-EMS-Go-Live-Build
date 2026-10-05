import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { LoginDto, RegisterDto, ChangePasswordDto } from './dto/auth.dto';
import { SystemRole, AuthUserResponse, TokensResponse } from '@ems/shared';
import * as crypto from 'crypto';

/**
 * F11 — email verification design decision.
 *
 * Chosen over admin-invite because self-registration is already the product's
 * onboarding path and the review only flagged "open registration → immediate
 * tokens". Invite-only would need an admin approval queue (new UX + workflow);
 * verification keeps the flow self-serve while ensuring (a) the address is
 * real and reachable before any session exists, and (b) no tokens are issued
 * until verification. Login is blocked with 403 EMAIL_NOT_VERIFIED.
 *
 * The token is 256-bit, stored SHA-256-hashed with a 24 h expiry, single-use
 * (cleared on success). Delivery: the token is enqueued to the notifications
 * queue (template 'email-verification', channel 'email') for the worker to
 * send; the server-side dev log remains ONLY as a fallback when the queue is
 * unavailable, and the raw token is never logged in production.
 */
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * F23 — login hardening.
 * After MAX_LOGIN_ATTEMPTS consecutive failures the account locks for
 * LOCKOUT_DURATION_MS. Counters reset on success and when an expired lockout
 * is observed. A progressive delay (sleep proportional to attempts) was
 * considered but rejected: it ties up event-loop workers under attack.
 * Per-route throttling (5 req/min @Throttle override on the auth endpoints) is the outer control.
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Phase 1 hardening (item 5): login never reveals account state. Every
 * post-password failure — locked, deactivated, unverified — returns the same
 * generic 401 as a wrong password, so attackers cannot enumerate account
 * status. The true reason is still recorded in the login audit log.
 */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password';

export type LoginResult =
  | { user: AuthUserResponse; tokens: TokensResponse }
  | { mfaRequired: true; challengeToken: string };

/**
 * MFA columns (worker 4 adds to the User model; reported in the build
 * handoff): `mfaSecret String?`, `mfaEnabled Boolean @default(false)`,
 * `mfaRecoveryHashes String[] @default([])`. Accessed through this narrow
 * structural type so the API compiles before the migration lands.
 */
interface MfaUserFields {
  mfaEnabled?: boolean | null;
  mfaSecret?: string | null;
  mfaRecoveryHashes?: string[] | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  private extractPermissions(user: any): string[] {
    const set = new Set<string>();
    for (const ur of user.roles || []) {
      for (const rp of ur.role?.permissions || []) {
        set.add(`${rp.permission.subject}:${rp.permission.action}`);
      }
    }
    return Array.from(set);
  }

  private hashVerificationToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private newVerificationToken(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = crypto.randomBytes(32).toString('hex'); // 256-bit
    return {
      token,
      tokenHash: this.hashVerificationToken(token),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    };
  }

  /**
   * B2: verification email is enqueued on the notifications queue
   * (channel 'email', template 'verification'). The worker renders the
   * template from `data` and delivers via SMTP. Idempotency key is the token
   * hash so a retried registration never double-sends. Queue failure is
   * fail-open with a loud warning (matching QueueService semantics); the raw
   * token is never logged in production.
   */
  private async emitVerificationEmail(userId: string, email: string, token: string): Promise<void> {
    const frontendUrl = this.configService.get<string>('frontendUrl', 'http://localhost:3000');
    const tokenHash = this.hashVerificationToken(token);
    try {
      await this.emailService.sendTemplated({
        to: email,
        userId,
        template: 'verification',
        data: {
          actionUrl: `${frontendUrl}/verify-email?token=${token}`,
          expiresNote: '24 hours',
        },
        idempotencyKey: `email-verification:${tokenHash}`,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to queue verification email for ${email}: ${(err as Error).message}. ` +
          'The user must use resend-verification once the queue is healthy.',
      );
    }
  }

  private async handleFailedLogin(user: { id: string; failedLoginAttempts?: number | null }): Promise<void> {
    const attempts = (user.failedLoginAttempts ?? 0) + 1;
    const data: { failedLoginAttempts: number; lockedUntil?: Date } = {
      failedLoginAttempts: attempts,
    };
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      data.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      this.logger.warn(`Account locked for user ${user.id} after ${attempts} failed login attempts`);
    }
    await this.prisma.user.update({ where: { id: user.id }, data });
  }

  private async resetLoginAttempts(user: { id: string; failedLoginAttempts?: number | null; lockedUntil?: Date | null }): Promise<void> {
    if ((user.failedLoginAttempts ?? 0) > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
  }

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string): Promise<LoginResult> {
    const user = await this.userService.findByEmail(dto.email);

    if (!user) {
      await this.recordLoginAudit(null, dto.email, false, 'User not found', ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    // Item 5: verify the password FIRST. Account-state checks below only run
    // on a correct password, and every one of them returns the same generic
    // message — no locked/deactivated/unverified oracle for attackers.
    const isPasswordValid = await this.passwordService.verify(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.handleFailedLogin(user);
      await this.recordLoginAudit(user.id, dto.email, false, 'Invalid credentials', ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    // Transparent hash upgrade: legacy PBKDF2 → Argon2id on next successful
    // login. Only on success — a failed verify must not touch the stored hash.
    if (this.passwordService.needsRehash(user.passwordHash)) {
      try {
        const upgraded = await this.passwordService.rehash(dto.password);
        await this.userService.updatePassword(user.id, upgraded);
        this.logger.log(`Upgraded password hash to Argon2id for user ${user.id}`);
      } catch (e) {
        // Non-fatal: the legacy hash still verifies; retry next login.
        this.logger.warn(`Argon2id rehash failed for user ${user.id}: ${(e as Error).message}`);
      }
    }

    // Password is correct — now enforce account state, all with ONE message.
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.recordLoginAudit(user.id, dto.email, false, 'Account locked (generic response)', ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }
    if (user.lockedUntil) {
      // Expired lockout starts a fresh attempt window instead of re-locking.
      await this.resetLoginAttempts(user);
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }
    if (!user.isActive) {
      await this.recordLoginAudit(user.id, dto.email, false, 'Account deactivated (generic response)', ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }
    if (!user.emailVerified) {
      await this.recordLoginAudit(user.id, dto.email, false, 'Email not verified (generic response)', ipAddress, userAgent);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    // Success: clear any accumulated failure counters.
    await this.resetLoginAttempts(user);
    await this.recordLoginAudit(user.id, dto.email, true, undefined, ipAddress, userAgent);

    // Phase 2 MFA (item 8): password passed, second factor still required.
    // Issue a short-lived challenge token; no session tokens yet.
    const mfa = user as unknown as MfaUserFields;
    if (mfa.mfaEnabled) {
      const challengeToken = await this.tokenService.createMfaChallengeToken(user.id);
      return { mfaRequired: true, challengeToken };
    }

    const roles: SystemRole[] = user.roles.map((r) => r.role.name as SystemRole);
    const permissions = this.extractPermissions(user);

    const tokens = await this.tokenService.generateTokens(
      user.id,
      user.email,
      roles,
      permissions,
      user.employee?.id,
      undefined,
      ipAddress,
    );

    const userProfile: AuthUserResponse = {
      id: user.id,
      email: user.email,
      firstName: user.employee?.firstName,
      lastName: user.employee?.lastName,
      roles,
      permissions,
      employeeId: user.employee?.id,
      employeeNumber: user.employee?.employeeNumber,
      avatarUrl: user.employee?.avatarUrl || undefined,
    };

    return { user: userProfile, tokens };
  }

  /**
   * B2: self-registration is invite-only by default.
   * ALLOW_PUBLIC_REGISTRATION=false (the default) closes this endpoint with
   * 403; new users arrive via HR-issued invitations (InvitationsService) or
   * the create-first-admin bootstrap script. When enabled, the original
   * verify-before-login flow applies unchanged.
   */
  async register(dto: RegisterDto, ipAddress?: string): Promise<{ user: AuthUserResponse; message: string }> {
    const allowed = this.configService.get<boolean>('security.allowPublicRegistration', false);
    if (!allowed) {
      throw new ForbiddenException(
        'Public registration is disabled. Please use the invitation link sent by your HR administrator.',
      );
    }

    const passwordHash = await this.passwordService.hash(dto.password);
    const { user, employee } = await this.userService.createUser(
      dto.email,
      passwordHash,
      dto.firstName,
      dto.lastName,
      [SystemRole.EMPLOYEE],
    );

    const { token, tokenHash, expiresAt } = this.newVerificationToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: false,
        emailVerificationToken: tokenHash,
        emailVerificationExpires: expiresAt,
      },
    });
    await this.emitVerificationEmail(user.id, user.email, token);

    await this.recordLoginAudit(user.id, user.email, true, 'Registered — pending email verification', ipAddress, undefined);

    const userProfile: AuthUserResponse = {
      id: user.id,
      email: user.email,
      firstName: employee.firstName,
      lastName: employee.lastName,
      roles: [SystemRole.EMPLOYEE],
      permissions: [],
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
    };

    return {
      user: userProfile,
      message: 'Account created. Please verify your email address before logging in.',
    };
  }

  /** F11: consume a verification token (single-use, 24 h expiry). */
  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.hashVerificationToken(token);
    const user = await this.prisma.user.findFirst({
      where: { emailVerificationToken: tokenHash },
      select: { id: true, emailVerificationExpires: true, emailVerified: true },
    });

    if (!user || !user.emailVerificationExpires || user.emailVerificationExpires <= new Date()) {
      throw new BadRequestException('Verification token is invalid or has expired. Request a new one.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    this.logger.log(`Email verified for user ${user.id}`);
  }

  /**
   * F11: re-issue a verification token. Enumeration-safe: always returns
   * success, whether or not the account exists or is already verified.
   */
  async resendVerification(email: string): Promise<void> {
    const user = await this.userService.findByEmail(email.toLowerCase());

    if (user && !user.emailVerified) {
      const { token, tokenHash, expiresAt } = this.newVerificationToken();
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationToken: tokenHash,
          emailVerificationExpires: expiresAt,
        },
      });
      await this.emitVerificationEmail(user.id, user.email, token);
    }
  }

  async refreshToken(token: string, ipAddress?: string): Promise<TokensResponse> {
    return this.tokenService.rotateRefreshToken(token, ipAddress);
  }

  /**
   * Phase 2 MFA (item 8): finish a login whose password check AND second
   * factor both succeeded (MfaService.completeChallenge). Issues the session
   * tokens and resets the failure counters. The caller must have verified the
   * challenge token and the TOTP/recovery code already.
   *
   * Go-live hardening: this is also the session-issuing point for the OAuth
   * path, so the account-state gates run HERE (not just in password login):
   * a locked account is rejected and an unverified email is rejected, with
   * the same generic message as password login (no account-state oracle).
   */
  async completeMfaLogin(
    userId: string,
    ipAddress?: string,
  ): Promise<{ user: AuthUserResponse; tokens: TokensResponse }> {
    const user = await this.userService.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    // Same gates as password login (item 5): lockout first, then the expired
    // lockout reset, then email verification — all one generic message.
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      await this.recordLoginAudit(user.id, user.email, false, 'Account locked (generic response)', ipAddress, undefined);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }
    if (user.lockedUntil) {
      // Expired lockout starts a fresh attempt window instead of re-locking.
      await this.resetLoginAttempts(user);
      user.lockedUntil = null;
      user.failedLoginAttempts = 0;
    }
    if (!user.emailVerified) {
      await this.recordLoginAudit(user.id, user.email, false, 'Email not verified (generic response)', ipAddress, undefined);
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    await this.resetLoginAttempts(user);
    await this.recordLoginAudit(user.id, user.email, true, 'MFA login completed', ipAddress, undefined);

    const roles: SystemRole[] = user.roles.map((r) => r.role.name as SystemRole);
    const permissions = this.extractPermissions(user);

    const tokens = await this.tokenService.generateTokens(
      user.id,
      user.email,
      roles,
      permissions,
      user.employee?.id,
      undefined,
      ipAddress,
    );

    const userProfile: AuthUserResponse = {
      id: user.id,
      email: user.email,
      firstName: user.employee?.firstName,
      lastName: user.employee?.lastName,
      roles,
      permissions,
      employeeId: user.employee?.id,
      employeeNumber: user.employee?.employeeNumber,
      avatarUrl: user.employee?.avatarUrl || undefined,
    };

    return { user: userProfile, tokens };
  }

  async logout(token?: string, userId?: string): Promise<void> {
    if (token) {
      await this.tokenService.revokeToken(token);
    } else if (userId) {
      await this.tokenService.revokeAllUserTokens(userId);
    }
  }

  async getMe(userId: string): Promise<AuthUserResponse> {
    const user = await this.userService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User profile not found');
    }

    const roles: SystemRole[] = user.roles.map((r) => r.role.name as SystemRole);
    const permissions = this.extractPermissions(user);

    return {
      id: user.id,
      email: user.email,
      firstName: user.employee?.firstName,
      lastName: user.employee?.lastName,
      roles,
      permissions,
      employeeId: user.employee?.id,
      employeeNumber: user.employee?.employeeNumber,
      avatarUrl: user.employee?.avatarUrl || undefined,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const isMatch = await this.passwordService.verify(dto.currentPassword, user.passwordHash);
    if (!isMatch) {
      throw new BadRequestException('Current password does not match');
    }

    // 12-char minimum + breach screening enforced inside hash().
    const newHash = await this.passwordService.hash(dto.newPassword);
    await this.userService.updatePassword(userId, newHash);

    // Invalidate existing sessions for security
    await this.tokenService.revokeAllUserTokens(userId);
  }

  private async recordLoginAudit(
    userId: string | null,
    emailAttempted: string,
    isSuccess: boolean,
    failureReason?: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    try {
      await this.prisma.loginAuditLog.create({
        data: {
          userId,
          emailAttempted,
          isSuccess,
          failureReason,
          ipAddress,
          userAgent,
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to record login audit: ${e.message}`);
    }
  }
}
