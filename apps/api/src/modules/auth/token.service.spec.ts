import { Test, TestingModule } from '@nestjs/testing';
import { TokenService } from './token.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { SystemRole } from '@ems/shared';
import * as crypto from 'crypto';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Token service tests: refresh-token rotation, reuse detection (family
 * revocation), expiry handling and revocation primitives. No real secrets —
 * all tokens are random test fixtures.
 */
describe('TokenService', () => {
  let service: TokenService;
  let jwtService: { sign: jest.Mock; verify: jest.Mock };
  let configService: { get: jest.Mock };
  let prisma: any;
  let redisService: { setIfAbsent: jest.Mock; getIsConnected: jest.Mock };

  const storedToken = (overrides: Record<string, any> = {}) => ({
    id: 'rt-1',
    tokenHash: 'stored-hash',
    userId: 'user-1',
    familyId: 'fam-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    isRevoked: false,
    user: {
      id: 'user-1',
      email: 'test@ems.local',
      roles: [
        {
          role: {
            name: SystemRole.EMPLOYEE,
            permissions: [{ permission: { subject: 'LEAVE', action: 'READ' } }],
          },
        },
      ],
      employee: { id: 'emp-1' },
    },
    ...overrides,
  });

  beforeEach(async () => {
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-access-token'),
      verify: jest.fn(),
    } as any;
    configService = {
      get: jest.fn((key: string, fallback?: any) => {
        if (key === 'jwt.accessSecret') return 'test-access-secret';
        if (key === 'jwt.accessExpiration') return '15m';
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        return fallback;
      }),
    };
    prisma = {
      refreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'rt-new' }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    redisService = {
      setIfAbsent: jest.fn().mockResolvedValue(true),
      getIsConnected: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  describe('generateTokens', () => {
    it('stores only the SHA-256 hash of the refresh token, never the raw token', async () => {
      const tokens = await service.generateTokens('user-1', 'test@ems.local', [SystemRole.EMPLOYEE], []);

      const [familyId, raw] = tokens.refreshToken.split('.');
      expect(familyId).toHaveLength(36); // UUID family
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tokenHash: sha256(raw),
          userId: 'user-1',
          familyId,
        }),
      });
      const storedHash = prisma.refreshToken.create.mock.calls[0][0].data.tokenHash;
      expect(storedHash).not.toContain(raw);
      expect(tokens.expiresIn).toBe(900);
      expect(tokens.tokenType).toBe('Bearer');
    });

    it('honors the REFRESH_TTL config for the refresh-token expiry', async () => {
      const before = Date.now();
      await service.generateTokens('user-1', 'test@ems.local', [SystemRole.EMPLOYEE], []);

      const expiresAt: Date = prisma.refreshToken.create.mock.calls[0][0].data.expiresAt;
      const skew = expiresAt.getTime() - before;
      expect(skew).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 5000);
      // 1s tolerance: `before` is captured before the service computes expiresAt.
      expect(skew).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
    });

    it('reuses the existing family id when rotating', async () => {
      const tokens = await service.generateTokens(
        'user-1',
        'test@ems.local',
        [SystemRole.EMPLOYEE],
        [],
        'emp-1',
        'existing-family',
      );

      expect(tokens.refreshToken.startsWith('existing-family.')).toBe(true);
      expect(prisma.refreshToken.create.mock.calls[0][0].data.familyId).toBe('existing-family');
    });

    it('signs the access token with the configured secret and expiry', async () => {
      await service.generateTokens('user-1', 'test@ems.local', [SystemRole.EMPLOYEE], ['LEAVE:READ'], 'emp-1');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          email: 'test@ems.local',
          roles: [SystemRole.EMPLOYEE],
          permissions: ['LEAVE:READ'],
          employeeId: 'emp-1',
        }),
        { secret: 'test-access-secret', expiresIn: 900 },
      );
    });
  });

  describe('rotateRefreshToken', () => {
    it('rejects a malformed token', async () => {
      await expect(service.rotateRefreshToken('not-a-valid-token')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.rotateRefreshToken('fam-1.unknownraw')).rejects.toThrow(UnauthorizedException);
    });

    it('detects reuse: revokes the whole family and rejects', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken({ isRevoked: true }));

      const err = await service.rotateRefreshToken('fam-1.someoldraw').catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toMatch(/reused/i);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'fam-1' },
        data: { isRevoked: true },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.rotateRefreshToken('fam-1.staleraw')).rejects.toThrow(
        /expired/i,
      );
    });

    it('rotates a valid token: atomic compare-and-set revoke, keeps the stored family id', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken());

      const tokens = await service.rotateRefreshToken('fam-1.validraw', '10.0.0.2');

      // Single conditional DB update — the atomic compare-and-set.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: 'rt-1', isRevoked: false },
        data: { isRevoked: true },
      });
      const [familyId] = tokens.refreshToken.split('.');
      expect(familyId).toBe('fam-1');
      expect(tokens.accessToken).toBe('signed-access-token');
    });

    it('takes the family id from the STORED record, never the client prefix', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken({ familyId: 'stored-fam' }));

      const tokens = await service.rotateRefreshToken('evil-family.validraw', '10.0.0.2');

      const [familyId] = tokens.refreshToken.split('.');
      expect(familyId).toBe('stored-fam');
      // Reuse-detection also burns the stored family, not the client one.
      expect(prisma.refreshToken.create.mock.calls[0][0].data.familyId).toBe('stored-fam');
    });

    it('treats a lost rotation race (conditional update hits 0 rows) as reuse', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken({ familyId: 'fam-1' }));
      prisma.refreshToken.updateMany
        .mockResolvedValueOnce({ count: 0 }) // the compare-and-set lost the race
        .mockResolvedValueOnce({ count: 3 }); // family burn

      const err = await service.rotateRefreshToken('fam-1.validraw').catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toMatch(/reused/i);
      // family burn targets the stored family id
      expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith({
        where: { familyId: 'fam-1' },
        data: { isRevoked: true },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('re-derives roles and permissions from the stored user on rotation', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken());

      await service.rotateRefreshToken('fam-1.validraw');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          roles: [SystemRole.EMPLOYEE],
          permissions: ['LEAVE:READ'],
          employeeId: 'emp-1',
        }),
        expect.anything(),
      );
    });
  });

  describe('revocation', () => {
    it('revokeToken marks the hashed token revoked', async () => {
      await service.revokeToken('fam-1.rawvalue');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: sha256('rawvalue') },
        data: { isRevoked: true },
      });
    });

    it('revokeToken ignores malformed input without throwing', async () => {
      await expect(service.revokeToken('garbage')).resolves.toBeUndefined();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('revokeAllUserTokens revokes every token of the user', async () => {
      await service.revokeAllUserTokens('user-1');

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { isRevoked: true },
      });
    });

    it('revokeTokenFamily revokes one session and returns the revoked count', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.revokeTokenFamily('user-1', 'fam-1');

      expect(count).toBe(2);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', familyId: 'fam-1', isRevoked: false },
        data: { isRevoked: true },
      });
    });
  });

  describe('MFA challenge tokens', () => {
    it('issues a challenge token carrying the mfa-challenge purpose and a jti', async () => {
      const token = await service.createMfaChallengeToken('user-1');

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-1', purpose: 'mfa-challenge', jti: expect.any(String) },
        { secret: 'test-access-secret', expiresIn: '5m' },
      );
      expect(typeof token).toBe('string');
    });

    it('issues a unique jti per challenge', async () => {
      await service.createMfaChallengeToken('user-1');
      await service.createMfaChallengeToken('user-1');
      const jtis = jwtService.sign.mock.calls.map((c) => c[0].jti);
      expect(new Set(jtis).size).toBe(2);
    });

    it('verifyMfaChallengeToken returns the user id and jti for a valid challenge', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: 'user-1',
        purpose: 'mfa-challenge',
        jti: 'jti-1',
      });

      await expect(service.verifyMfaChallengeToken('challenge')).resolves.toEqual({
        userId: 'user-1',
        jti: 'jti-1',
      });
    });

    it('verifyMfaChallengeToken rejects tokens with the wrong purpose', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({ sub: 'user-1', purpose: 'access', jti: 'jti-1' });

      await expect(service.verifyMfaChallengeToken('challenge')).rejects.toThrow(UnauthorizedException);
    });

    it('verifyMfaChallengeToken rejects challenges without a jti (pre-fix tokens fail closed)', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({ sub: 'user-1', purpose: 'mfa-challenge' });

      await expect(service.verifyMfaChallengeToken('challenge')).rejects.toThrow(UnauthorizedException);
    });

    it('verifyMfaChallengeToken rejects expired/tampered tokens', async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(service.verifyMfaChallengeToken('stale')).rejects.toThrow(/expired/i);
    });

    it('consumeMfaChallengeToken claims the jti on first use', async () => {
      await service.consumeMfaChallengeToken('jti-1');

      expect(redisService.setIfAbsent).toHaveBeenCalledWith(
        'mfa:challenge:consumed:jti-1',
        '1',
        600,
      );
    });

    it('consumeMfaChallengeToken rejects a replayed challenge jti', async () => {
      redisService.setIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await service.consumeMfaChallengeToken('jti-replay');
      await expect(service.consumeMfaChallengeToken('jti-replay')).rejects.toThrow(
        /already been used/,
      );
    });

    it('claimTotpTimeStep returns true on first claim, false on replay', async () => {
      redisService.setIfAbsent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.claimTotpTimeStep('user-1', 59705814, 90)).resolves.toBe(true);
      await expect(service.claimTotpTimeStep('user-1', 59705814, 90)).resolves.toBe(false);
      expect(redisService.setIfAbsent).toHaveBeenCalledWith(
        'mfa:totp:used:user-1:59705814',
        '1',
        90,
      );
    });

    it('replay guards fail closed by default (with Redis down) and alert on loss', async () => {
      redisService.getIsConnected.mockReturnValue(false);

      await expect(service.consumeMfaChallengeToken('jti-x')).rejects.toThrow(ServiceUnavailableException);
      await expect(service.claimTotpTimeStep('user-1', 1, 90)).rejects.toThrow(ServiceUnavailableException);
      expect(redisService.setIfAbsent).not.toHaveBeenCalled();
    });

    it('replay guards fail open only when REDIS_REPLAY_FAIL_CLOSED=false', async () => {
      redisService.getIsConnected.mockReturnValue(false);
      (configService.get as jest.Mock).mockImplementation((key: string, fallback?: any) => {
        if (key === 'REDIS_REPLAY_FAIL_CLOSED') return 'false';
        return fallback;
      });

      await expect(service.consumeMfaChallengeToken('jti-x')).resolves.toBeUndefined();
      await expect(service.claimTotpTimeStep('user-1', 1, 90)).resolves.toBe(true);
      expect(redisService.setIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('listActiveSessions', () => {
    it('returns one row per family (newest token wins)', async () => {
      prisma.refreshToken.findMany.mockResolvedValue([
        { familyId: 'fam-a', createdAt: new Date('2026-10-05'), createdIp: '1.1.1.1', expiresAt: new Date('2026-10-12') },
        { familyId: 'fam-a', createdAt: new Date('2026-10-04'), createdIp: '1.1.1.1', expiresAt: new Date('2026-10-11') },
        { familyId: 'fam-b', createdAt: new Date('2026-10-03'), createdIp: '2.2.2.2', expiresAt: new Date('2026-10-10') },
      ]);

      const sessions = await service.listActiveSessions('user-1');

      expect(sessions).toHaveLength(2);
      expect(sessions[0].familyId).toBe('fam-a');
      expect(sessions[1].familyId).toBe('fam-b');
    });
  });
});
