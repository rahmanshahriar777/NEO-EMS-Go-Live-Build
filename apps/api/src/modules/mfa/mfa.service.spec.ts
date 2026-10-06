import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { AuthService } from '../auth/auth.service';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

/**
 * MfaService tests (Phase 2, item 8): TOTP setup/verify/disable, recovery
 * codes (hashed, one-time), MFA challenge completion, active sessions.
 * The User.mfa* columns are provided by worker 4's migration; mocked here
 * via `(prisma as any).user`.
 */
describe('MfaService', () => {
  let service: MfaService;
  let prisma: any;
  let passwordService: { verify: jest.Mock };
  let tokenService: {
    verifyMfaChallengeToken: jest.Mock;
    consumeMfaChallengeToken: jest.Mock;
    claimTotpTimeStep: jest.Mock;
    listActiveSessions: jest.Mock;
    revokeTokenFamily: jest.Mock;
    revokeAllUserTokens: jest.Mock;
  };
  let authService: { completeMfaLogin: jest.Mock };
  let configGet: jest.Mock;

  const mfaRow = (overrides: Record<string, any> = {}) => ({
    mfaSecret: 'PENDINGSECRET',
    mfaEnabled: false,
    mfaRecoveryHashes: [],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    passwordService = { verify: jest.fn() };
    tokenService = {
      verifyMfaChallengeToken: jest.fn(),
      consumeMfaChallengeToken: jest.fn().mockResolvedValue(undefined),
      claimTotpTimeStep: jest.fn().mockResolvedValue(true),
      listActiveSessions: jest.fn().mockResolvedValue([]),
      revokeTokenFamily: jest.fn().mockResolvedValue(1),
      revokeAllUserTokens: jest.fn().mockResolvedValue(undefined),
    };
    authService = {
      completeMfaLogin: jest.fn().mockResolvedValue({
        user: { id: 'user-1' },
        tokens: { accessToken: 'at', refreshToken: 'rt' },
      }),
    };
    configGet = jest.fn((key: string, fallback?: any) => {
      if (key === 'mfa.issuer') return 'NEO EMS';
      if (key === 'mfa.totpWindow') return 1;
      return fallback;
    });

    (generateSecret as jest.Mock).mockReturnValue('NEWSECRET123');
    (generateURI as jest.Mock).mockReturnValue('otpauth://totp/test');
    (verifySync as jest.Mock).mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    service = module.get<MfaService>(MfaService);
  });

  describe('setupTotp', () => {
    it('stores a pending secret and returns it with the otpauth URI', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow());

      const result = await service.setupTotp('user-1', 'jane@ems.local');

      expect(result.secret).toBe('NEWSECRET123');
      expect(result.otpauthUrl).toBe('otpauth://totp/test');
      expect(generateURI).toHaveBeenCalledWith({ issuer: 'NEO EMS', label: 'jane@ems.local', secret: 'NEWSECRET123' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mfaSecret: 'NEWSECRET123' },
      });
    });

    it('refuses to re-enroll while MFA is enabled', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: true }));

      await expect(service.setupTotp('user-1', 'jane@ems.local')).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifySetup', () => {
    it('enables MFA and returns one-time recovery codes on a valid TOTP', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow());
      (verifySync as jest.Mock).mockReturnValue({ valid: true });

      const result = await service.verifySetup('user-1', '123456');

      expect(verifySync).toHaveBeenCalledWith({
        secret: 'PENDINGSECRET',
        token: '123456',
        epochTolerance: 30,
      });
      expect(result.recoveryCodes).toHaveLength(10);
      expect(new Set(result.recoveryCodes).size).toBe(10);

      const stored = prisma.user.update.mock.calls[0][0].data;
      expect(stored.mfaEnabled).toBe(true);
      expect(stored.mfaRecoveryHashes).toHaveLength(10);
      // only Argon2id hashes are stored — no raw code may appear in the DB write
      for (const raw of result.recoveryCodes) {
        expect(stored.mfaRecoveryHashes).not.toContain(raw);
        let verified = false;
        for (const h of stored.mfaRecoveryHashes) {
          if (await argon2.verify(h, raw)) {
            verified = true;
            break;
          }
        }
        expect(verified).toBe(true);
      }
    }, 20000);

    it('rejects an invalid TOTP code', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow());
      (verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verifySetup('user-1', '000000')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects verify-setup without a pending secret', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaSecret: null }));
      (verifySync as jest.Mock).mockReturnValue({ valid: true });

      await expect(service.verifySetup('user-1', '123456')).rejects.toThrow(BadRequestException);
    });
  });

  describe('disableMfa', () => {
    it('clears all MFA state after password confirmation', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'h' });
      passwordService.verify.mockResolvedValue(true);

      await service.disableMfa('user-1', 'CorrectPassword123!');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryHashes: [] },
      });
    });

    it('rejects a wrong password', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'h' });
      passwordService.verify.mockResolvedValue(false);

      await expect(service.disableMfa('user-1', 'wrong')).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('completeChallenge', () => {
    it('completes login with a valid TOTP code', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: true, mfaSecret: 'REAL' }));
      (verifySync as jest.Mock).mockReturnValue({ valid: true, timeStep: 59705814 });

      const result = await service.completeChallenge('challenge', '123456', '10.0.0.1');

      expect(result.user.id).toBe('user-1');
      // P0-7b: the code's time-step is claimed before the session is minted.
      expect(tokenService.claimTotpTimeStep).toHaveBeenCalledWith('user-1', 59705814, 90);
      // P0-7a: the challenge jti is consumed after the factor verified.
      expect(tokenService.consumeMfaChallengeToken).toHaveBeenCalledWith('jti-1');
      expect(authService.completeMfaLogin).toHaveBeenCalledWith('user-1', '10.0.0.1');
    });

    it('rejects a replayed challenge token (consumed jti)', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-used' });
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: true, mfaSecret: 'REAL' }));
      (verifySync as jest.Mock).mockReturnValue({ valid: true, timeStep: 59705814 });
      tokenService.consumeMfaChallengeToken.mockRejectedValue(
        new UnauthorizedException('MFA challenge token has already been used'),
      );

      await expect(service.completeChallenge('challenge', '123456')).rejects.toThrow(
        /already been used/,
      );
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('rejects a replayed TOTP code within its epoch window', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: true, mfaSecret: 'REAL' }));
      // Same code as the first login: otplib reports the same time-step.
      (verifySync as jest.Mock).mockReturnValue({ valid: true, timeStep: 59705814 });
      tokenService.claimTotpTimeStep.mockResolvedValue(false); // step already consumed

      await expect(service.completeChallenge('challenge', '123456')).rejects.toThrow(
        /already been used/,
      );
      expect(tokenService.consumeMfaChallengeToken).not.toHaveBeenCalled();
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('accepts a fresh TOTP code in the next time window', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-2' });
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: true, mfaSecret: 'REAL' }));
      (verifySync as jest.Mock).mockReturnValue({ valid: true, timeStep: 59705815 });
      tokenService.claimTotpTimeStep.mockResolvedValue(true);

      const result = await service.completeChallenge('challenge', '654321');

      expect(result.user.id).toBe('user-1');
      expect(tokenService.claimTotpTimeStep).toHaveBeenCalledWith('user-1', 59705815, 90);
      expect(authService.completeMfaLogin).toHaveBeenCalledWith('user-1', undefined);
    });

    it('accepts an unused recovery code exactly once (hash deleted)', async () => {
      const raw = 'ABCD-EFGH';
      const h = crypto.createHash('sha256').update(raw).digest('hex');
      const hashes = [h, 'other-hash'];
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique.mockResolvedValue(
        mfaRow({ mfaEnabled: true, mfaSecret: 'REAL', mfaRecoveryHashes: hashes }),
      );
      (verifySync as jest.Mock).mockReturnValue({ valid: false });

      await service.completeChallenge('challenge', raw);

      // Atomic claim: conditional update on the exact array we read.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', mfaRecoveryHashes: { equals: hashes } },
        data: { mfaRecoveryHashes: ['other-hash'] },
      });
      expect(authService.completeMfaLogin).toHaveBeenCalled();
    });

    it('rejects a recovery code already consumed by a concurrent request (no double-spend)', async () => {
      const raw = 'ABCD-EFGH';
      const h = crypto.createHash('sha256').update(raw).digest('hex');
      const hashes = [h, 'other-hash'];
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique
        .mockResolvedValueOnce(
          mfaRow({ mfaEnabled: true, mfaSecret: 'REAL', mfaRecoveryHashes: hashes }),
        )
        // Retry re-reads: the concurrent request already took the code.
        .mockResolvedValueOnce(
          mfaRow({ mfaEnabled: true, mfaSecret: 'REAL', mfaRecoveryHashes: ['other-hash'] }),
        );
      (verifySync as jest.Mock).mockReturnValue({ valid: false });
      prisma.user.updateMany.mockResolvedValue({ count: 0 }); // lost the race

      await expect(service.completeChallenge('challenge', raw)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('rejects a wrong TOTP and unknown recovery code', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique.mockResolvedValue(
        mfaRow({ mfaEnabled: true, mfaSecret: 'REAL', mfaRecoveryHashes: ['some-hash'] }),
      );
      (verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.completeChallenge('challenge', '000000')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('rejects when MFA is not enabled', async () => {
      tokenService.verifyMfaChallengeToken.mockResolvedValue({ userId: 'user-1', jti: 'jti-1' });
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: false }));

      await expect(service.completeChallenge('challenge', '123456')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getStatus', () => {
    it('reports enrollment state without exposing the secret', async () => {
      prisma.user.findUnique.mockResolvedValue(
        mfaRow({ mfaEnabled: true, mfaSecret: 'REAL', mfaRecoveryHashes: ['a', 'b', 'c'] }),
      );

      const status = await service.getStatus('user-1');

      expect(status).toEqual({ enabled: true, hasPendingSetup: false, recoveryCodesRemaining: 3 });
      expect(status).not.toHaveProperty('mfaSecret');
    });

    it('reports a pending setup after setupTotp but before verify', async () => {
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaEnabled: false, mfaSecret: 'PENDING' }));

      const status = await service.getStatus('user-1');

      expect(status).toEqual({ enabled: false, hasPendingSetup: true, recoveryCodesRemaining: 0 });
    });
  });

  describe('active sessions', () => {
    it('lists sessions', async () => {
      tokenService.listActiveSessions.mockResolvedValue([
        { familyId: 'fam-a', createdAt: new Date(), createdIp: '1.1.1.1', expiresAt: new Date() },
      ]);

      const sessions = await service.listSessions('user-1');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].familyId).toBe('fam-a');
      expect(sessions[0].id).toBe('fam-a');
      expect(sessions[0].ipAddress).toBe('1.1.1.1');
    });

    it('revokes one session; 400 when unknown', async () => {
      await service.revokeSession('user-1', 'fam-a');
      expect(tokenService.revokeTokenFamily).toHaveBeenCalledWith('user-1', 'fam-a');

      tokenService.revokeTokenFamily.mockResolvedValue(0);
      await expect(service.revokeSession('user-1', 'nope')).rejects.toThrow(BadRequestException);
    });

    it('revokes all sessions', async () => {
      await service.revokeAllSessions('user-1');
      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });
  });

  describe('keyring encryption', () => {
    it('encrypts secret with DOCUMENT_ENCRYPTION_KEY and decrypts successfully', async () => {
      configGet.mockImplementation((key: string, fallback?: any) => {
        if (key === 'DOCUMENT_ENCRYPTION_KEY') return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        if (key === 'mfa.issuer') return 'NEO EMS';
        if (key === 'mfa.totpWindow') return 1;
        return fallback;
      });

      prisma.user.findUnique.mockResolvedValue(mfaRow());
      await service.setupTotp('user-1', 'jane@ems.local');

      const savedSecret = prisma.user.update.mock.calls[prisma.user.update.mock.calls.length - 1][0].data.mfaSecret;
      expect(savedSecret).toMatch(/^enc:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

      // Now verify getStatus decrypts it without exposing secret
      prisma.user.findUnique.mockResolvedValue(mfaRow({ mfaSecret: savedSecret }));
      const status = await service.getStatus('user-1');
      expect(status.hasPendingSetup).toBe(true);
    });
  });
});
