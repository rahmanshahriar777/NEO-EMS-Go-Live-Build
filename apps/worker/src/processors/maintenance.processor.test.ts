/**
 * Unit tests for the maintenance processor (mocked Prisma).
 *
 * Covers:
 * - purgeExpiredAiLogs: dry-run (explicit + default) never deletes,
 * - the counsel sign-off gate (HIGH #3): dry-run BY DEFAULT; a real delete
 *   needs BOTH GDPR_RETENTION_SIGNED_OFF=true AND an explicit dryRun:false —
 *   without sign-off the purge deletes nothing even when asked not to be a
 *   dry run,
 * - real run: deleteMany called with the retention cutoff,
 * - retention window resolution: payload > env > 90-day default,
 * - invalid retention windows are rejected loudly,
 * - processMaintenance dispatch: unknown operations throw; the scheduled-
 *   reports operation throws loudly when no runner is registered
 *   (worker 3 owns registerScheduledReportsRunner()).
 *
 * Assumption documented in the processor: 90 days is a counsel-sign-off
 * placeholder, not a legal determination.
 *
 * Run: npx tsx --test src/processors/maintenance.processor.unit.spec.ts
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@ems/database';
import {
  processMaintenance,
  purgeExpiredAiLogs,
  AI_LOG_RETENTION_DAYS_DEFAULT,
} from './maintenance.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';

const job = (data: any) => ({ id: 'job-m1', data } as any);

const ENV_KEYS = ['AI_LOG_RETENTION_DAYS', 'GDPR_RETENTION_SIGNED_OFF'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('purgeExpiredAiLogs', () => {
  test('dry-run: counts matches but never deletes', async (t) => {
    const count = stubPrisma(prisma.aIRequestLog, 'count', async () => 42, t);
    const del = stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 0 }), t);

    const out = await purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs', dryRun: true }));

    assert.equal(count.calls.length, 1);
    assert.equal(del.calls.length, 0, 'dry-run must not delete');
    assert.deepEqual(
      { matched: out.matched, deleted: out.deleted, dryRun: out.dryRun, retentionDays: out.retentionDays },
      { matched: 42, deleted: 0, dryRun: true, retentionDays: AI_LOG_RETENTION_DAYS_DEFAULT },
    );
  });

  test('real run (signed off + explicit dryRun:false): deleteMany uses the retention cutoff', async (t) => {
    process.env.GDPR_RETENTION_SIGNED_OFF = 'true';
    const count = stubPrisma(prisma.aIRequestLog, 'count', async () => 7, t);
    const del = stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 7 }), t);

    const out = await purgeExpiredAiLogs(
      job({ operation: 'purgeExpiredAiLogs', dryRun: false, retentionDays: 30 }),
    );

    assert.equal(del.calls.length, 1);
    const where = del.calls[0][0].where;
    const cutoff: Date = where.createdAt.lt;
    assert.ok(cutoff instanceof Date);
    const ageMs = Date.now() - cutoff.getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    assert.ok(ageMs >= thirtyDays - 5000 && ageMs <= thirtyDays + 5000,
      `cutoff should be ~30 days ago, was ${ageMs}ms`);
    assert.equal(out.deleted, 7);
    assert.equal(out.dryRun, false);
    assert.equal(out.signedOff, true);
    // Count and delete use the same cutoff basis.
    const countWhere = count.calls[0][0].where;
    assert.equal(countWhere.createdAt.lt.getTime(), cutoff.getTime());
  });

  test('HIGH #3: without sign-off, explicit dryRun:false is forced back to dry-run — deletes nothing', async (t) => {
    // GDPR_RETENTION_SIGNED_OFF unset (beforeEach cleared it).
    stubPrisma(prisma.aIRequestLog, 'count', async () => 11, t);
    const del = stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 11 }), t);

    const out = await purgeExpiredAiLogs(
      job({ operation: 'purgeExpiredAiLogs', dryRun: false }),
    );

    assert.equal(out.dryRun, true, 'must be forced to dry-run without sign-off');
    assert.equal(out.signedOff, false);
    assert.equal(out.deleted, 0);
    assert.equal(del.calls.length, 0, 'no rows may be deleted without counsel sign-off');
  });

  test('HIGH #3: default (silent payload, no sign-off) is dry-run — the scheduled job never deletes', async (t) => {
    // This is exactly what schedule.ts enqueues every night: no dryRun flag.
    stubPrisma(prisma.aIRequestLog, 'count', async () => 5, t);
    const del = stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 5 }), t);

    const out = await purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs' }));

    assert.equal(out.dryRun, true);
    assert.equal(out.deleted, 0);
    assert.equal(del.calls.length, 0);
  });

  test('HIGH #3: with sign-off but no explicit dryRun:false, still dry-run', async (t) => {
    process.env.GDPR_RETENTION_SIGNED_OFF = 'true';
    stubPrisma(prisma.aIRequestLog, 'count', async () => 5, t);
    const del = stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 5 }), t);

    const out = await purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs' }));

    assert.equal(out.dryRun, true, 'sign-off alone must not arm deletes');
    assert.equal(del.calls.length, 0);
  });

  test('env AI_LOG_RETENTION_DAYS is used when the payload omits retentionDays', async (t) => {
    process.env.AI_LOG_RETENTION_DAYS = '14';
    stubPrisma(prisma.aIRequestLog, 'count', async () => 0, t);
    stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 0 }), t);

    const out = await purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs', dryRun: true }));

    assert.equal(out.retentionDays, 14);
  });

  test('payload retentionDays wins over env', async (t) => {
    process.env.AI_LOG_RETENTION_DAYS = '14';
    stubPrisma(prisma.aIRequestLog, 'count', async () => 0, t);
    stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 0 }), t);

    const out = await purgeExpiredAiLogs(
      job({ operation: 'purgeExpiredAiLogs', dryRun: true, retentionDays: 60 }),
    );

    assert.equal(out.retentionDays, 60);
  });

  test('invalid retention windows throw loudly', async (t) => {
    stubPrisma(prisma.aIRequestLog, 'count', async () => 0, t);
    await assert.rejects(
      purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs', retentionDays: 0 })),
      /Invalid retention window/,
    );
    await assert.rejects(
      purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs', retentionDays: -5 })),
      /Invalid retention window/,
    );
    process.env.AI_LOG_RETENTION_DAYS = 'not-a-number';
    await assert.rejects(
      purgeExpiredAiLogs(job({ operation: 'purgeExpiredAiLogs', dryRun: true })),
      /Invalid retention window/,
    );
  });
});

describe('processMaintenance dispatch', () => {
  test('unknown operations throw', async () => {
    await assert.rejects(
      processMaintenance(job({ operation: 'definitelyNotAnOperation' } as any)),
      /Unknown maintenance operation/,
    );
  });

  test('runScheduledReports with no runner registered throws loudly', async () => {
    // Worker 3 has not called registerScheduledReportsRunner() in this
    // process; the processor must fail loudly rather than silently skip.
    await assert.rejects(
      processMaintenance(job({ operation: 'runScheduledReports' } as any)),
      /no runner registered/,
    );
  });

  test('purgeExpiredAiLogs dispatches through processMaintenance', async (t) => {
    stubPrisma(prisma.aIRequestLog, 'count', async () => 1, t);
    stubPrisma(prisma.aIRequestLog, 'deleteMany', async () => ({ count: 0 }), t);

    const out: any = await processMaintenance(
      job({ operation: 'purgeExpiredAiLogs', dryRun: true, retentionDays: 90 }),
    );

    assert.equal(out.operation, 'purgeExpiredAiLogs');
    assert.equal(out.matched, 1);
  });
});
