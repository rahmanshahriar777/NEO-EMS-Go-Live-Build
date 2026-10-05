import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { EmailService } from '../../common/email/email.service';

/**
 * Password reset (Phase 1 hardening, item 4).
 *
 * - POST /auth/password-reset/request: ALWAYS returns 200 with a generic
 *   message (enumeration-safe). When the email belongs to a user, a 256-bit
 *   single-use token (SHA-256-hashed at rest, 60-min expiry) is stored in the
 *   existing `password_reset_tokens` table and emailed via the 'password-reset'
 *   template.
 * - POST /auth/password-reset/confirm: consumes the token, sets the new
 *   password (12-char minimum + breach screening enforced by
 *   PasswordService.hash), marks the token used, revokes all sessions and
 *   clears any lockout so a locked-out user can recover.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async requestPasswordReset(email: string): Promise<void> {
    const normalized = email.toLowerCase().trim();
    const user = await this.userService.findByEmail(normalized);

    // Enumeration-safe: identical (silent) behaviour for unknown emails.
    if (!user) {
      this.logger.log(`Password-reset requested for unknown email ${normalized} (no-op)`);
      return;
    }

    const ttlMinutes = this.configService.get<number>('passwordReset.ttlMinutes', 60);
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);

    await this.prisma.passwordResetToken.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
      },
    });

    const frontendUrl = this.configService.get<string>('frontendUrl', 'http://localhost:3000');
    await this.emailService.sendTemplated({
      to: user.email,
      userId: user.id,
      template: 'password-reset',
      data: {
        actionUrl: `${frontendUrl}/reset-password?token=${token}`,
        expiresNote: `${ttlMinutes} minutes`,
      },
      idempotencyKey: `password-reset:${tokenHash}`,
    });
  }

  /**
   * Consume a reset token. TOCTOU-safe: the token is claimed with a
   * CONDITIONAL updateMany (usedAt: null + not expired) and the affected
   * row count is verified — two concurrent confirms cannot both win; the
   * loser sees count 0 and gets the generic invalid/expired error. The read
   * above is only for a friendly pre-check and for loading the user; the
   * updateMany is the single source of truth for "was this token consumed".
   */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new BadRequestException('Password-reset token is invalid or has expired. Request a new one.');
    }

    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      // Lost the race to a concurrent confirm (or the token expired between
      // the pre-check and the claim) — same generic message, no oracle.
      throw new BadRequestException('Password-reset token is invalid or has expired. Request a new one.');
    }

    // 12-char minimum + breach screening enforced inside hash().
    const newHash = await this.passwordService.hash(newPassword);

    await this.prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: newHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // A reset is a credential change: invalidate every existing session.
    await this.tokenService.revokeAllUserTokens(record.userId);
    this.logger.log(`Password reset completed for user ${record.userId}`);
  }
}
