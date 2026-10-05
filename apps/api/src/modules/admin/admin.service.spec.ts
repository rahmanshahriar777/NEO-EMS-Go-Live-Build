import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { TokenService } from '../auth/token.service';
import { AuditAction } from '@ems/shared';

/**
 * AdminService tests (go-live Phase 2 item 8): unlock clears lockout state
 * and kills sessions revokes every refresh token. Both are audit-logged.
 */
describe('AdminService', () => {
  let service: AdminService;
  let prisma: any;
  let audit: { log: jest.Mock };
  let tokenService: { revokeAllUserTokens: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    audit = { log: jest.fn().mockResolvedValue({}) };
    tokenService = { revokeAllUserTokens: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe('unlockUser', () => {
    it('clears lockedUntil/failedLoginAttempts and audits the action', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'locked@ems.local',
        lockedUntil: new Date(Date.now() + 600_000),
        failedLoginAttempts: 5,
      });

      const result = await service.unlockUser('u-1', { userId: 'admin-1', email: 'a@ems.local' });

      expect(result).toEqual({ id: 'u-1', unlocked: true });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { lockedUntil: null, failedLoginAttempts: 0 },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: AuditAction.UPDATE,
          entityType: 'USER_ACCOUNT',
          entityId: 'u-1',
        }),
      );
    });

    it('404s for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.unlockUser('nope', { userId: 'admin-1' })).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('killSessions', () => {
    it('revokes all refresh tokens and audits the action', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-2', email: 'x@ems.local' });

      const result = await service.killSessions('u-2', { userId: 'admin-1' });

      expect(result).toEqual({ id: 'u-2', sessionsRevoked: true });
      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('u-2');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: AuditAction.UPDATE,
          entityType: 'USER_SESSIONS',
          entityId: 'u-2',
        }),
      );
    });

    it('404s for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.killSessions('nope', { userId: 'admin-1' })).rejects.toThrow(
        NotFoundException,
      );
      expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    });
  });
});
