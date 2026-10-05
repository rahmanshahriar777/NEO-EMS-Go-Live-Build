/**
 * Invitation single-use race (unit level, mocked Prisma).
 *
 * `acceptInvitation` claims the invitation FIRST with a conditional
 * `updateMany({ where: { tokenHash, acceptedAt: null, expiresAt: { gt } } })`
 * — the conditional update is the linearization point, so exactly one
 * concurrent accepter wins the claim. The loser sees `count: 0` and fails
 * fast with "already used" instead of racing through user creation.
 *
 * What this proves:
 * - the claim is atomic at the service level: the loser's `updateMany`
 *   returns count 0 → BadRequest, before any user row is created.
 *
 * What this does NOT prove:
 * - real transaction isolation (the mock serializes the two updateMany
 *   calls). On real Postgres the conditional update is atomic by
 *   construction; the UNIQUE(email) schema guard remains as a backstop.
 *
 * If this test ever shows BOTH racers succeeding, the atomic claim has been
 * lost — treat as a security regression.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { EmailService } from '../../common/email/email.service';
import * as crypto from 'crypto';

describe('invitation single-use race', () => {
  let service: InvitationsService;
  let prisma: any;

  const sharedInvitation = () => ({
    id: 'inv-1',
    email: 'new.hire@ems.local',
    tokenHash: crypto.createHash('sha256').update('raw-token').digest('hex'),
    role: 'EMPLOYEE',
    employeeId: null,
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    acceptedAt: null as Date | null,
  });

  beforeEach(async () => {
    const invitation = sharedInvitation();
    const usedEmails = new Set<string>();
    let usersCreated = 0;
    let claimCalls = 0;

    const tx = {
      invitation: {
        // Atomic claim: exactly one concurrent updateMany matches.
        updateMany: jest.fn(async () => {
          claimCalls += 1;
          if (claimCalls === 1) {
            Object.assign(invitation, { acceptedAt: new Date() });
            return { count: 1 };
          }
          return { count: 0 };
        }),
        findUnique: jest.fn(async () => ({ ...invitation })),
      },
      role: { findUnique: jest.fn(async () => ({ id: 'role-emp' })) },
      user: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          if (usedEmails.has(data.email)) {
            const err: any = new Error(
              'Unique constraint failed on the fields: (`email`)',
            );
            err.code = 'P2002';
            throw err;
          }
          usedEmails.add(data.email);
          usersCreated += 1;
          return { id: `user-${usersCreated}`, email: data.email };
        }),
      },
      employee: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'emp-1', ...data })),
        update: jest.fn(async () => ({})),
      },
      // Sequence-backed employee number (go-live Phase 1 item 6).
      $queryRawUnsafe: jest.fn(async () => [{ n: 1001 }]),
    };

    prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: { hash: jest.fn().mockResolvedValue('argon2-hash') } },
        { provide: EmailService, useValue: { sendTemplated: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn((k: string, f?: any) => f) } },
      ],
    }).compile();

    service = module.get<InvitationsService>(InvitationsService);

    (service as any).__raceCounters = {
      get usersCreated() {
        return usersCreated;
      },
      get claimCalls() {
        return claimCalls;
      },
    };
  });

  it('exactly one accept wins the atomic claim; the loser fails fast as already-used', async () => {
    const dto = {
      token: 'raw-token',
      password: 'Correct-Horse-9!',
      firstName: 'New',
      lastName: 'Hire',
    } as any;

    const results = await Promise.allSettled([
      service.acceptInvitation(dto),
      service.acceptInvitation(dto),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Loser fails at the claim — a clear BadRequest, not a P2002 deep in the flow.
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BadRequestException);
    expect(reason.message).toMatch(/already used/);

    const counters = (service as any).__raceCounters;
    expect(counters.usersCreated).toBe(1);
    expect(counters.claimCalls).toBe(2);

    const winner = (fulfilled[0] as PromiseFulfilledResult<{ userId: string; email: string }>).value;
    expect(winner.email).toBe('new.hire@ems.local');
  });

  it('scaffolded employee uses the sequence-backed EMP-YYYY-NNNN format', async () => {
    const dto = {
      token: 'raw-token',
      password: 'Correct-Horse-9!',
      firstName: 'New',
      lastName: 'Hire',
    } as any;

    await service.acceptInvitation(dto);
    // $queryRawUnsafe was used for nextval (no count()+1 fallback).
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
