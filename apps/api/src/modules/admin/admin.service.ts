import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { TokenService } from '../auth/token.service';
import { AuditAction } from '@ems/shared';

export interface AdminActor {
  userId: string;
  email?: string;
}

/**
 * Go-live Phase 2 item 8 — admin account recovery actions.
 *
 * Both endpoints are destructive-ish (they override security state), so
 * every call is audit-logged with actor, before/after state. They follow
 * the auth/users convention: SUPER_ADMIN or HR_ADMIN only (guarded at the
 * controller), target user must exist (404 otherwise).
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * Clear a lockout: resets lockedUntil and failedLoginAttempts so the user
   * can sign in again immediately. Does NOT change the password or sessions.
   */
  async unlockUser(id: string, actor: AdminActor): Promise<{ id: string; unlocked: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, lockedUntil: true, failedLoginAttempts: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.update({
      where: { id },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });

    await this.audit.log({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: AuditAction.UPDATE,
      entityType: 'USER_ACCOUNT',
      entityId: id,
      beforeState: {
        lockedUntil: user.lockedUntil,
        failedLoginAttempts: user.failedLoginAttempts,
      },
      afterState: { lockedUntil: null, failedLoginAttempts: 0, unlocked: true },
    });

    this.logger.log(`User ${id} (${user.email}) unlocked by admin ${actor.userId}`);
    return { id, unlocked: true };
  }

  /**
   * Terminate every session for a user: revokes all refresh tokens, so all
   * devices/browsers are signed out on next refresh. Access tokens expire
   * naturally (short TTL); they are not individually revocable.
   */
  async killSessions(id: string, actor: AdminActor): Promise<{ id: string; sessionsRevoked: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.tokenService.revokeAllUserTokens(id);

    await this.audit.log({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: AuditAction.UPDATE,
      entityType: 'USER_SESSIONS',
      entityId: id,
      afterState: { sessionsRevoked: true },
    });

    this.logger.log(`All sessions for user ${id} (${user.email}) revoked by admin ${actor.userId}`);
    return { id, sessionsRevoked: true };
  }
}
