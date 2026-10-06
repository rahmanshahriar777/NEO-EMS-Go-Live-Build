import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * F23 — login hardening.
 * After MAX_LOGIN_ATTEMPTS consecutive failures the account locks for
 * LOCKOUT_DURATION_MS. Counters reset on success and when an expired lockout
 * is observed. A progressive delay (sleep proportional to attempts) was
 * considered but rejected: it ties up event-loop workers under attack.
 * Per-route throttling (5 req/min @Throttle override on the auth endpoints) is the outer control.
 */
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks whether a user account is currently locked.
   */
  isLocked(user: { lockedUntil?: Date | null }): boolean {
    return Boolean(user.lockedUntil && user.lockedUntil > new Date());
  }

  /**
   * Records a failed login attempt and locks the account if the threshold is breached.
   */
  async handleFailedLogin(user: { id: string; failedLoginAttempts?: number | null }): Promise<void> {
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

  /**
   * Resets login failure counters and unlocks the account if necessary.
   */
  async resetLoginAttempts(user: {
    id: string;
    failedLoginAttempts?: number | null;
    lockedUntil?: Date | null;
  }): Promise<void> {
    if ((user.failedLoginAttempts ?? 0) > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }
  }
}
