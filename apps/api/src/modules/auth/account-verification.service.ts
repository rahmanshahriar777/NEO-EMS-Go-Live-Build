import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { UserService } from './user.service';
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
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class AccountVerificationService {
  private readonly logger = new Logger(AccountVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  hashVerificationToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  newVerificationToken(): { token: string; tokenHash: string; expiresAt: Date } {
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
  async emitVerificationEmail(userId: string, email: string, token: string): Promise<void> {
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
}
