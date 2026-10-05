/**
 * Unit tests for the leave-accrual processor (mocked Prisma + mocked Redis).
 *
 * HIGH #4 regression: the processor's old Redis client used
 * `lazyConnect: true` and never called `connect()` — with
 * `enableOfflineQueue: false` every command rejected, so every monthly
 * accrual run failed into the DLQ. These tests prove the processor boots
 * against an injected (mocked) shared connection and runs the full pass.
 *
 * Covers:
 * - injection: the processor uses the connection given to
 *   setLeaveAccrualRedis() (the worker's shared BullMQ connection in
 *   production),
 * - a full pass credits each active employee once per policy, sets the
 *   completion marker, and releases the distributed lock,
 * - a repeat fire in the same month short-circuits on the marker,
 * - a lock held by another worker skips the run without accruing,
 * - a BullMQ retry resumes via the per-employee done-set (no double
 *   credit).
 *
 * Run: npx tsx --test src/processors/leave-accrual.processor.unit.spec.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type Redis from 'ioredis';
import { prisma } from '@ems/database';
import {
  accrueMonthlyLeave,
  setLeaveAccrualRedis,
} from './leave-accrual.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';

/** In-memory stand-in for the ioredis commands the processor uses. */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sets.has(key) ? 1 : 0;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    // Supports set(k, v, 'EX', ttl) and set(k, v, 'EX', ttl, 'NX').
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    const added = !s.has(member);
    s.add(member);
    return added ? 1 : 0;
  }

  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }

  /** Only used for the compare-and-del lock release. */
  async eval(_script: string, numKeys: number, ...args: any[]): Promise<number> {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);
    if (this.strings.get(keys[0]) === argv[0]) {
      this.strings.delete(keys[0]);
      return 1;
    }
    return 0;
  }
}

const job = (data: any = {}) => ({ id: 'job-acc-1', data } as any);

function markerKeyForNow(): string {
  const now = new Date();
  return `ems:accrual:leave:${now.getFullYear()}:${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const POLICIES = [
  { leaveTypeId: 'lt-1', accrualPerMonth: 2, leaveType: { name: 'Annual' } },
];
const EMPLOYEES = [{ id: 'e1' }, { id: 'e2' }];

function stubPrismaForAccrual(t: any) {
  stubPrisma(prisma.leavePolicy, 'findMany', async () => POLICIES, t);
  stubPrisma(prisma.employee, 'findMany', async (args: any) => {
    // Cursor page (where.id.gt set) → no more rows.
    if (args?.where?.id) return [];
    return EMPLOYEES;
  }, t);
  return stubPrisma(prisma as any, '$queryRaw', async () => [], t);
}

describe('accrueMonthlyLeave', () => {
  test('boots on the injected connection: credits each employee, sets the marker, releases the lock', async (t) => {
    const fake = new FakeRedis();
    setLeaveAccrualRedis(fake as unknown as Redis);
    const queryRaw = stubPrismaForAccrual(t);

    const out: any = await accrueMonthlyLeave(job({ correlationId: 'acc-test-1' }));

    assert.equal(queryRaw.calls.length, EMPLOYEES.length * POLICIES.length,
      'one credit upsert per employee per policy');
    assert.equal(out.credited, 2);
    assert.equal(out.skipped, 0);
    const markerKey = markerKeyForNow();
    assert.equal(await fake.exists(markerKey), 1, 'completion marker must be set');
    assert.equal(fake.sets.get(`${markerKey}:done`)?.size, 2, 'done-set records both credits');
    assert.equal(await fake.exists(`${markerKey}:lock`), 0, 'lock must be released after the pass');
  });

  test('repeat fire in the same month short-circuits on the completion marker', async (t) => {
    const fake = new FakeRedis();
    setLeaveAccrualRedis(fake as unknown as Redis);
    const queryRaw = stubPrismaForAccrual(t);
    await fake.set(markerKeyForNow(), new Date().toISOString(), 'EX', 3600);

    const out: any = await accrueMonthlyLeave(job({}));

    assert.equal(out.skipped, true);
    assert.equal(queryRaw.calls.length, 0, 'no credits on a repeat fire');
  });

  test('lock held by another worker: run is skipped without accruing', async (t) => {
    const fake = new FakeRedis();
    setLeaveAccrualRedis(fake as unknown as Redis);
    const queryRaw = stubPrismaForAccrual(t);
    const markerKey = markerKeyForNow();
    await fake.set(`${markerKey}:lock`, 'other-worker-token', 'EX', 3600);

    const out: any = await accrueMonthlyLeave(job({}));

    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'lock-held');
    assert.equal(queryRaw.calls.length, 0, 'must not accrue while another worker holds the lock');
    assert.equal(fake.strings.get(`${markerKey}:lock`), 'other-worker-token',
      'must not steal or clobber the other worker’s lock');
  });

  test('BullMQ retry resumes via the done-set: already-credited employees are skipped', async (t) => {
    const fake = new FakeRedis();
    setLeaveAccrualRedis(fake as unknown as Redis);
    const queryRaw = stubPrismaForAccrual(t);
    const markerKey = markerKeyForNow();
    // Simulate a partially completed earlier attempt: e1 already credited.
    await fake.sadd(`${markerKey}:done`, 'e1:lt-1');

    const out: any = await accrueMonthlyLeave(job({}));

    assert.equal(out.credited, 1, 'only the uncredited employee is credited');
    assert.equal(out.skipped, 1);
    assert.equal(queryRaw.calls.length, 1, 'no double credit for e1');
    assert.equal(await fake.exists(`${markerKey}:lock`), 0, 'lock released even on the resume path');
  });
});
