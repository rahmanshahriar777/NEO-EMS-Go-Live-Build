/**
 * Refresh-token reuse detection — full lifecycle (unit level, mocked Prisma).
 *
 * Complements token.service.spec.ts (isolated rotation cases) by walking the
 * real attack/defense sequence end to end:
 *   1. issue token A (family F);
 *   2. rotate with A -> token B issued, A revoked, family F preserved;
 *   3. attacker replays A -> reuse detected: ENTIRE family F revoked, 401;
 *   4. legitimate holder tries B afterwards -> rejected (family is dead).
 *
 * This is the observable outcome of the double-rotation race without a real
 * database; the interleaved-timing variant is covered by the e2e suite.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TokenService } from './token.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { UnauthorizedException } from '@nestjs/common';
import { SystemRole } from '@ems/shared';
import * as crypto from 'crypto';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('refresh-token reuse: full lifecycle', () => {
  let service: TokenService;
  let prisma: any;
  let signCounter = 0;

  const userRow = () => ({
    id: 'user-1',
    email: 'victim@ems.local',
    roles: [
      { role: { name: SystemRole.EMPLOYEE, permissions: [] } },
    ],
    employee: { id: 'emp-1' },
  });

  /** In-memory refresh_token table keyed by tokenHash. */
  let table: Map<string, any>;

  beforeEach(async () => {
    table = new Map();
    signCounter = 0;

    prisma = {
      refreshToken: {
        create: jest.fn(({ data }: any) => {
          const row = { id: `rt-${table.size + 1}`, isRevoked: false, user: userRow(), ...data };
          table.set(data.tokenHash, row);
          return Promise.resolve(row);
        }),
        findUnique: jest.fn(({ where }: any) => Promise.resolve(table.get(where.tokenHash) ?? null)),
        update: jest.fn(({ where, data }: any) => {
          const row = [...table.values()].find((r) => r.id === where.id);
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          let count = 0;
          for (const row of table.values()) {
            const matchFamily = where.familyId !== undefined ? row.familyId === where.familyId : true;
            const matchHash = where.tokenHash !== undefined ? row.tokenHash === where.tokenHash : true;
            const matchUser = where.userId !== undefined ? row.userId === where.userId : true;
            if (matchFamily && matchHash && matchUser) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return Promise.resolve({ count });
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: { sign: jest.fn(() => `signed-${++signCounter}`) } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string, f?: any) => (k === 'jwt.accessSecret' ? 'test-secret' : f)) },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: RedisService,
          useValue: { setIfAbsent: jest.fn().mockResolvedValue(true), getIsConnected: jest.fn().mockReturnValue(true) },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('replay of a rotated token kills the whole family; the successor token dies too', async () => {
    // 1. Issue token A.
    const issued = await service.generateTokens('user-1', 'victim@ems.local', [SystemRole.EMPLOYEE], []);
    const [familyF, rawA] = issued.refreshToken.split('.');
    expect(table.size).toBe(1);

    // 2. Legitimate rotation with A -> token B, same family.
    const rotated = await service.rotateRefreshToken(issued.refreshToken, '10.0.0.1');
    const [familyB, rawB] = rotated.refreshToken.split('.');
    expect(familyB).toBe(familyF);
    expect(table.get(sha256(rawA)).isRevoked).toBe(true);
    expect(table.size).toBe(2);

    // 3. Attacker replays the stolen token A -> reuse detected.
    const replayErr = await service.rotateRefreshToken(issued.refreshToken, '203.0.113.9').catch((e) => e);
    expect(replayErr).toBeInstanceOf(UnauthorizedException);
    expect(replayErr.message).toMatch(/reused/i);
    // Entire family revoked — including the legitimate token B.
    for (const row of table.values()) {
      expect(row.isRevoked).toBe(true);
    }
    expect(rawB).not.toBe(rawA);

    // 4. Legitimate holder's token B is now dead too.
    await expect(service.rotateRefreshToken(rotated.refreshToken)).rejects.toThrow(UnauthorizedException);
  });

  it('rotating the same live token twice without an intervening issue is reuse', async () => {
    const issued = await service.generateTokens('user-1', 'victim@ems.local', [SystemRole.EMPLOYEE], []);
    const first = await service.rotateRefreshToken(issued.refreshToken);
    expect(first.refreshToken).not.toBe(issued.refreshToken);

    // Second use of the ORIGINAL raw token (not the successor): the stored
    // row is revoked -> family-wide revocation.
    await expect(service.rotateRefreshToken(issued.refreshToken)).rejects.toThrow(/reused/i);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: issued.refreshToken.split('.')[0] },
      data: { isRevoked: true },
    });
  });

  it('revokeAllUserTokens kills every family of the user at once', async () => {
    const t1 = await service.generateTokens('user-1', 'victim@ems.local', [SystemRole.EMPLOYEE], []);
    const t2 = await service.generateTokens('user-1', 'victim@ems.local', [SystemRole.EMPLOYEE], []);
    expect(t1.refreshToken.split('.')[0]).not.toBe(t2.refreshToken.split('.')[0]);

    await service.revokeAllUserTokens('user-1');

    await expect(service.rotateRefreshToken(t1.refreshToken)).rejects.toThrow(UnauthorizedException);
    await expect(service.rotateRefreshToken(t2.refreshToken)).rejects.toThrow(UnauthorizedException);
  });
});
