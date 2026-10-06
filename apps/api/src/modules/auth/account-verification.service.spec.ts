import { BadRequestException } from '@nestjs/common';
import { AccountVerificationService, EMAIL_VERIFICATION_TTL_MS } from './account-verification.service';

describe('AccountVerificationService', () => {
  let service: AccountVerificationService;
  let prisma: any;
  let emailService: any;
  let configService: any;
  let userService: any;

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    emailService = {
      sendTemplated: jest.fn().mockResolvedValue('job-1'),
    };
    configService = {
      get: jest.fn((key: string, fallback?: any) => {
        if (key === 'frontendUrl') return 'http://localhost:3000';
        return fallback;
      }),
    };
    userService = {
      findByEmail: jest.fn(),
    };

    service = new AccountVerificationService(prisma, emailService, configService, userService);
  });

  describe('newVerificationToken', () => {
    it('creates a 256-bit hex token with hash and 24h expiry', () => {
      const before = Date.now();
      const result = service.newVerificationToken();
      const after = Date.now();

      expect(result.token).toHaveLength(64);
      expect(result.tokenHash).toHaveLength(64);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + EMAIL_VERIFICATION_TTL_MS);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + EMAIL_VERIFICATION_TTL_MS + 1000);
    });
  });

  describe('emitVerificationEmail', () => {
    it('dispatches templated email with actionUrl and idempotencyKey', async () => {
      await service.emitVerificationEmail('user-1', 'test@ems.local', 'token123');

      expect(emailService.sendTemplated).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@ems.local',
          userId: 'user-1',
          template: 'verification',
          data: expect.objectContaining({
            actionUrl: 'http://localhost:3000/verify-email?token=token123',
          }),
          idempotencyKey: expect.stringMatching(/^email-verification:/),
        }),
      );
    });
  });

  describe('verifyEmail', () => {
    it('verifies valid unexpired token', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        emailVerified: false,
        emailVerificationExpires: new Date(Date.now() + 60 * 60 * 1000),
      });

      await service.verifyEmail('valid-raw-token');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpires: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    });

    it('rejects expired token', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        emailVerified: false,
        emailVerificationExpires: new Date(Date.now() - 60 * 1000),
      });

      await expect(service.verifyEmail('expired-token')).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown token', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.verifyEmail('unknown-token')).rejects.toThrow(BadRequestException);
    });
  });

  describe('resendVerification', () => {
    it('re-issues and emits verification email if user exists and unverified', async () => {
      userService.findByEmail.mockResolvedValue({
        id: 'user-1',
        email: 'test@ems.local',
        emailVerified: false,
      });

      await service.resendVerification('test@ems.local');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          emailVerificationToken: expect.any(String),
          emailVerificationExpires: expect.any(Date),
        }),
      });
      expect(emailService.sendTemplated).toHaveBeenCalled();
    });

    it('no-ops safely if user already verified', async () => {
      userService.findByEmail.mockResolvedValue({
        id: 'user-1',
        email: 'test@ems.local',
        emailVerified: true,
      });

      await service.resendVerification('test@ems.local');

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(emailService.sendTemplated).not.toHaveBeenCalled();
    });
  });
});
