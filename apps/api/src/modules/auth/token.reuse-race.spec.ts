/**
 * Refresh-token double-rotation race (unit level, mocked Prisma).
 *
 * Simulates the worst-case interleaving WITHOUT a database: two concurrent
 * `rotateRefreshToken` calls for the SAME token both complete their read
 * (`findUnique` sees the token unrevoked) before either performs the
 * compare-and-set revoke. The mocked `updateMany` applies the
 * `WHERE id AND isRevoked = false` condition atomically (single synchronous
 * decision, mirroring the database's atomic UPDATE), so exactly one caller
 * wins the CAS; the loser sees `count === 0` and is treated as reuse.
 *
 * What this proves:
 * - the conditional-update logic serializes the race: exactly one rotation
 *   succeeds, the loser is rejected as reuse, and the family is burned.
 *
 * What this does NOT prove:
 * - true DB-level atomicity under parallel connections (the mock's atomicity
 *   is single-threaded JS). The interleaved-timing variant needs the e2e
 *   suite against real Postgres.
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

describe('refresh-token rotation race: double submit of the same token', () => {
  let service: TokenService;
  let prisma: any;
  let signCounter = 0;

  const userRow = () => ({
    id: 'user-1',
    email: 'victim@ems.local',
    isActive: true,
    lockedUntil: null,
    roles: [{ role: { name: SystemRole.EMPLOYEE, permissions: [] } }],
    employee: { id: 'emp-1' },
  });

  /** In-memory refresh_token table keyed by tokenHash. */
  let table: Map<string, any>;

  beforeEach(async () => {
    table = new Map();
    signCounter = 0;

    let findCalls = 0;
    let releaseReaders: () => void = () => undefined;
    const bothHaveRead = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });

    prisma = {
      refreshToken: {
        create: jest.fn(({ data }: any) => {
          const row = { id: `rt-${table.size + 1}`, isRevoked: false, ...data };
          table.set(data.tokenHash, row);
          return Promise.resolve(row);
        }),
        // Barrier: both concurrent rotations complete the READ (seeing the
        // token unrevoked) before either performs the CAS revoke. This is
        // the interleaving a real race produces.
        findUnique: jest.fn(async () => {
          findCalls += 1;
          if (findCalls >= 2) releaseReaders();
          await bothHaveRead;
          const row = [...table.values()][0];
          return { ...row, user: userRow() };
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          // Atomic compare-and-set, mirroring the DB: revoke only if still
          // unrevoked. The whole decision is synchronous — no await before
          // the verdict — so exactly one racer can win.
          if (where.id !== undefined && where.isRevoked === false) {
            const row = [...table.values()].find((r) => r.id === where.id);
            if (row && !row.isRevoked) {
              Object.assign(row, data);
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }
          if (where.familyId !== undefined) {
            let count = 0;
            for (const row of table.values()) {
              if (row.familyId === where.familyId) {
                Object.assign(row, data);
                count += 1;
              }
            }
            return Promise.resolve({ count });
          }
          return Promise.resolve({ count: 0 });
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

  it('exactly one rotation wins; the loser is rejected as reuse and the family dies', async () => {
    const issued = await service.generateTokens('user-1', 'victim@ems.local', [SystemRole.EMPLOYEE], []);
    const familyF = issued.refreshToken.split('.')[0];
    expect(table.size).toBe(1);

    const results = await Promise.allSettled([
      service.rotateRefreshToken(issued.refreshToken, '10.0.0.1'),
      service.rotateRefreshToken(issued.refreshToken, '10.0.0.2'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(UnauthorizedException);
    expect(rejection.message).toMatch(/reused/i);

    // The loser's reuse path burns the whole family — including the token the
    // winner just minted. Afterwards no unrevoked token remains in family F.
    const familyRows = [...table.values()].filter((r) => r.familyId === familyF);
    expect(familyRows.length).toBeGreaterThanOrEqual(2);
    expect(familyRows.every((r) => r.isRevoked)).toBe(true);
  });
});
