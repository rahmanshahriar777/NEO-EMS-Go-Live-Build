import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PasswordResetService } from './password-reset.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { EmailService } from '../../common/email/email.service';
import * as crypto from 'crypto';

/**
 * PasswordResetService tests (item 4):
 *  - request is enumeration-safe (unknown email = silent no-op),
 *  - token is stored hashed with an expiry and emailed,
 *  - confirm enforces the password policy, marks single-use, revokes sessions.
 */
describe('PasswordResetService', () => {
  let service: PasswordResetService;
  let prisma: any;
  let userService: { findByEmail: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let tokenService: { revokeAllUserTokens: jest.Mock };
  let emailService: { sendTemplated: jest.Mock };
  let configGet: jest.Mock;

  beforeEach(async () => {
    prisma = {
      passwordResetToken: {
        create: jest.fn().mockResolvedValue({ id: 'prt-1' }),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { update: jest.fn() },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops.map((op) => op))),
    };
    userService = { findByEmail: jest.fn() };
    passwordService = { hash: jest.fn().mockResolvedValue('argon2-hash') };
    tokenService = { revokeAllUserTokens: jest.fn().mockResolvedValue(undefined) };
    emailService = { sendTemplated: jest.fn().mockResolvedValue('job-1') };
    configGet = jest.fn((key: string, fallback?: any) => {
      if (key === 'passwordReset.ttlMinutes') return 60;
      if (key === 'frontendUrl') return 'http://localhost:3000';
      return fallback;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        { provide: PrismaService, useValue: prisma },
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<PasswordResetService>(PasswordResetService);
  });

  describe('requestPasswordReset', () => {
    it('is a silent no-op for unknown emails (enumeration-safe)', async () => {
      userService.findByEmail.mockResolvedValue(null);

      await expect(service.requestPasswordReset('ghost@ems.local')).resolves.toBeUndefined();

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(emailService.sendTemplated).not.toHaveBeenCalled();
    });

    it('stores a SHA-256-hashed token with a 60-minute expiry and emails the raw token', async () => {
      userService.findByEmail.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });

      await service.requestPasswordReset('jane@ems.local');

      const created = prisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(created.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(created.userId).toBe('user-1');
      expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);

      const emailed = emailService.sendTemplated.mock.calls[0][0];
      expect(emailed.to).toBe('jane@ems.local');
      expect(emailed.template).toBe('password-reset');
      expect(emailed.data.actionUrl).toContain('http://localhost:3000/reset-password?token=');
      expect(emailed.idempotencyKey).toBe(`password-reset:${created.tokenHash}`);
      // the raw token in the URL must hash to the stored tokenHash
      const rawFromUrl = emailed.data.actionUrl.split('token=')[1];
      expect(crypto.createHash('sha256').update(rawFromUrl).digest('hex')).toBe(created.tokenHash);
    });
  });

  describe('confirmPasswordReset', () => {
    const record = (overrides: Record<string, any> = {}) => ({
      id: 'prt-1',
      tokenHash: 'hash',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      user: { id: 'user-1' },
      ...overrides,
    });

    it('rejects unknown tokens', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(null);

      await expect(service.confirmPasswordReset('nope', 'LongEnoughPassword123!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects already-used tokens (single-use)', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(record({ usedAt: new Date() }));

      await expect(service.confirmPasswordReset('used', 'LongEnoughPassword123!')).rejects.toThrow(
        BadRequestException,
      );
      expect(passwordService.hash).not.toHaveBeenCalled();
    });

    it('rejects expired tokens', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(
        record({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.confirmPasswordReset('stale', 'LongEnoughPassword123!')).rejects.toThrow(
        /expired/i,
      );
    });

    it('sets the new password, marks the token used, clears lockout, revokes sessions', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(record());

      await service.confirmPasswordReset('valid-token', 'LongEnoughPassword123!');

      expect(passwordService.hash).toHaveBeenCalledWith('LongEnoughPassword123!');
      // TOCTOU-safe claim: conditional update on usedAt:null, count verified.
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'prt-1', usedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { passwordHash: 'argon2-hash', failedLoginAttempts: 0, lockedUntil: null },
      });
      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });

    it('rejects when a concurrent confirm wins the token claim (count 0)', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(record());
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.confirmPasswordReset('valid-token', 'LongEnoughPassword123!')).rejects.toThrow(
        BadRequestException,
      );
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    });
  });
});
