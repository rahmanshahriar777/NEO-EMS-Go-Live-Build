/**
 * V4-1 (CRITICAL): MFA challenge JWTs are signed with the same access-token
 * secret as session tokens. If JwtStrategy.validate() accepts them, a
 * challenge token presented as a Bearer token authenticates — full MFA
 * bypass with only the victim's password. These tests pin the invariant:
 * any JWT carrying a `purpose` claim must be rejected by the session
 * strategy; challenge tokens remain valid only for POST /mfa/challenge
 * (TokenService.verifyMfaChallengeToken — covered in token.service.spec.ts).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemRole, JwtPayload } from '@ems/shared';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisCacheService } from '../../core/redis/redis-cache.service';

describe('JwtStrategy (V4-1: purpose-claim rejection)', () => {
  let strategy: JwtStrategy;
  let prisma: { user: { findUnique: jest.Mock } };
  let cache: { getUserActive: jest.Mock; setUserActive: jest.Mock };

  const sessionPayload: JwtPayload = {
    sub: 'user-1',
    email: 'u@ems.local',
    roles: [SystemRole.EMPLOYEE],
    permissions: [],
  };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn() } };
    cache = { getUserActive: jest.fn(), setUserActive: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'jwt.accessSecret' ? 'test-access-secret' : undefined)) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisCacheService, useValue: cache },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  it('rejects a challenge JWT (purpose: mfa-challenge) presented as a Bearer session token', async () => {
    const challengePayload = { ...sessionPayload, purpose: 'mfa-challenge', jti: 'some-jti' };
    await expect(strategy.validate(challengePayload)).rejects.toThrow(UnauthorizedException);
    // The rejection must happen before any user lookup — the token is
    // invalid as a session credential regardless of account state.
    expect(cache.getUserActive).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects ANY non-session purpose value, not just mfa-challenge', async () => {
    for (const purpose of ['access', 'reset', 'invite', '']) {
      await expect(strategy.validate({ ...sessionPayload, purpose })).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('accepts a session token without a purpose claim (active user, cache hit)', async () => {
    cache.getUserActive.mockResolvedValue(true);
    await expect(strategy.validate(sessionPayload)).resolves.toEqual(sessionPayload);
  });

  it('accepts a session token without a purpose claim (active user, DB fallback)', async () => {
    cache.getUserActive.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', isActive: true });
    await expect(strategy.validate(sessionPayload)).resolves.toEqual(sessionPayload);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, isActive: true },
    });
  });

  it('still rejects inactive users (existing behavior preserved)', async () => {
    cache.getUserActive.mockResolvedValue(false);
    await expect(strategy.validate(sessionPayload)).rejects.toThrow(UnauthorizedException);
  });
});
