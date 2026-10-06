import { LockoutService, MAX_LOGIN_ATTEMPTS, LOCKOUT_DURATION_MS } from './lockout.service';

describe('LockoutService', () => {
  let service: LockoutService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      user: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new LockoutService(prisma);
  });

  describe('isLocked', () => {
    it('returns true when lockedUntil is in the future', () => {
      const lockedUntil = new Date(Date.now() + 60 * 1000);
      expect(service.isLocked({ lockedUntil })).toBe(true);
    });

    it('returns false when lockedUntil is null', () => {
      expect(service.isLocked({ lockedUntil: null })).toBe(false);
    });

    it('returns false when lockedUntil is in the past', () => {
      const lockedUntil = new Date(Date.now() - 60 * 1000);
      expect(service.isLocked({ lockedUntil })).toBe(false);
    });
  });

  describe('handleFailedLogin', () => {
    it('increments failed login attempts without locking when under threshold', async () => {
      await service.handleFailedLogin({ id: 'u-1', failedLoginAttempts: 2 });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { failedLoginAttempts: 3 },
      });
    });

    it('locks the account for 15 minutes when attempts reach MAX_LOGIN_ATTEMPTS', async () => {
      const before = Date.now();
      await service.handleFailedLogin({ id: 'u-1', failedLoginAttempts: MAX_LOGIN_ATTEMPTS - 1 });
      const after = Date.now();

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: {
          failedLoginAttempts: MAX_LOGIN_ATTEMPTS,
          lockedUntil: expect.any(Date),
        },
      });

      const callData = prisma.user.update.mock.calls[0][0].data;
      const lockedTime = callData.lockedUntil.getTime();
      expect(lockedTime).toBeGreaterThanOrEqual(before + LOCKOUT_DURATION_MS);
      expect(lockedTime).toBeLessThanOrEqual(after + LOCKOUT_DURATION_MS + 1000);
    });
  });

  describe('resetLoginAttempts', () => {
    it('resets attempts and lockout if attempts > 0 or locked', async () => {
      await service.resetLoginAttempts({
        id: 'u-1',
        failedLoginAttempts: 4,
        lockedUntil: new Date(),
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    it('no-ops if user has 0 attempts and not locked', async () => {
      await service.resetLoginAttempts({
        id: 'u-1',
        failedLoginAttempts: 0,
        lockedUntil: null,
      });

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
