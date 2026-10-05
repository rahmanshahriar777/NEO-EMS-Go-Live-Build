/**
 * Recovery-code double-spend race (unit level, mocked Prisma).
 *
 * Simulates the worst-case interleaving WITHOUT a database: two concurrent
 * `completeChallenge` calls presenting the SAME recovery code both complete
 * their read (seeing the code as unused) before either writes.
 *
 * The implementation under test defends with OPTIMISTIC CONCURRENCY
 * (see `consumeRecoveryCode`): the write is a conditional `updateMany` whose
 * WHERE clause requires the stored hash array to be byte-identical to what
 * was read (`mfaRecoveryHashes: { equals: hashes }`). The mocked `updateMany`
 * applies that condition atomically (single synchronous decision, mirroring
 * the database), so exactly one racer claims the code; the loser re-reads
 * once, finds the code gone, and is rejected with 'Invalid MFA code'.
 *
 * What this proves:
 * - the conditional-update logic serializes the race: exactly one login
 *   succeeds per recovery code; the loser cannot double-spend.
 *
 * What this does NOT prove:
 * - true DB-level atomicity under parallel connections (the mock's atomicity
 *   is single-threaded JS). The interleaved-timing variant needs the e2e
 *   suite against real Postgres.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { AuthService } from '../auth/auth.service';
import { verifySync } from 'otplib';
import * as crypto from 'crypto';

jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('recovery-code double-spend race', () => {
  let service: MfaService;
  let prisma: any;
  let authService: { completeMfaLogin: jest.Mock };

  const RAW_CODE = 'ABCD-EFGH';
  const CODE_HASH = sha256(RAW_CODE);

  /** The "stored" hash array; mutated only by a winning conditional write. */
  let storedHashes: string[];

  beforeEach(async () => {
    storedHashes = [CODE_HASH, 'other-hash'];

    let findCalls = 0;
    let releaseReaders: () => void = () => undefined;
    const bothHaveRead = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });

    prisma = {
      user: {
        // Barrier on the FIRST read of each racer: both see the code as
        // unused before either writes. Later reads (the loser's retry, the
        // winner's log line) see current state with no barrier.
        findUnique: jest.fn(async () => {
          findCalls += 1;
          if (findCalls === 2) releaseReaders();
          if (findCalls <= 2) await bothHaveRead;
          return {
            mfaSecret: 'REAL',
            mfaEnabled: true,
            mfaRecoveryHashes: [...storedHashes],
          };
        }),
        // Atomic conditional write, mirroring the DB: lands only when the
        // stored array is byte-identical to the racer's read snapshot.
        updateMany: jest.fn(async ({ where, data }: any) => {
          const expected: string[] = where?.mfaRecoveryHashes?.equals;
          const matches =
            Array.isArray(expected) &&
            expected.length === storedHashes.length &&
            expected.every((h, i) => h === storedHashes[i]);
          if (matches) {
            storedHashes = [...data.mfaRecoveryHashes];
            return { count: 1 };
          }
          return { count: 0 };
        }),
        update: jest.fn(async () => ({})),
      },
    };
    authService = {
      completeMfaLogin: jest.fn().mockResolvedValue({
        user: { id: 'user-1' },
        tokens: { accessToken: 'at', refreshToken: 'rt' },
      }),
    };

    (verifySync as jest.Mock).mockReset();
    (verifySync as jest.Mock).mockReturnValue({ valid: false }); // force the recovery-code path

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn((k: string, f?: any) => f) } },
        { provide: PasswordService, useValue: { verify: jest.fn() } },
        {
          provide: TokenService,
          useValue: {
            verifyMfaChallengeToken: jest
              .fn()
              .mockResolvedValue({ userId: 'user-1', jti: 'jti-1' }),
            consumeMfaChallengeToken: jest.fn().mockResolvedValue(undefined),
            claimTotpTimeStep: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    service = module.get<MfaService>(MfaService);
  });

  it('the same recovery code logs in exactly once; the loser is rejected', async () => {
    const results = await Promise.allSettled([
      service.completeChallenge('challenge', RAW_CODE),
      service.completeChallenge('challenge', RAW_CODE),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(UnauthorizedException);
    expect(reason.message).toMatch(/Invalid MFA code/);

    expect(authService.completeMfaLogin).toHaveBeenCalledTimes(1);
    expect(storedHashes).toEqual(['other-hash']);

    // The loser's conditional write failed (count 0) and its retry re-read:
    // exactly two updateMany attempts, one winner.
    const counts = prisma.user.updateMany.mock.calls.length;
    expect(counts).toBe(2);
  });

  it('two DIFFERENT codes consumed concurrently do not clobber each other', async () => {
    const OTHER_RAW = 'WXYZ-2345';
    const OTHER_HASH = sha256(OTHER_RAW);
    storedHashes = [CODE_HASH, OTHER_HASH];

    const results = await Promise.allSettled([
      service.completeChallenge('challenge', RAW_CODE),
      service.completeChallenge('challenge', OTHER_RAW),
    ]);

    // Both succeed: the loser of the first CAS retries, re-reads, finds its
    // own code still present, and claims it without clobbering.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(authService.completeMfaLogin).toHaveBeenCalledTimes(2);
    expect(storedHashes).toEqual([]);
  });
});
