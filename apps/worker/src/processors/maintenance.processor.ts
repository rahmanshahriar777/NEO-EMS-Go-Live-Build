import { Job, Queue } from 'bullmq';
import { prisma } from '@ems/database';
import {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  RETENTION_SIGNOFF_ENV,
  isRetentionSignedOff,
  type MaintenanceJobPayload,
} from '@ems/shared';
import { log } from '../logger.js';
import { markNightlyAbsences } from './attendance.processor.js';
import { accrueMonthlyLeave } from './leave-accrual.processor.js';
import { getScheduledReportsRunner } from '../schedule.js';

/**
 * Maintenance processor: retention and housekeeping jobs.
 *
 * Supported operations:
 * - purgeExpiredAiLogs: deletes AIRequestLog rows older than the retention
 *   window (env AI_LOG_RETENTION_DAYS, default 90). Supports dry-run.
 *
 * Retention schedule: counsel-signed retention periods are still pending
 * (review §6 step 2) — 90 days is a placeholder default, not a legal
 * determination. Do not shorten without sign-off.
 *
 * Supported operations:
 * - purgeExpiredAiLogs: as above (existing retention-purge hook).
 * - markNightlyAbsences: Phase 2 item 5 — nightly absence marking, scheduled
 *   by schedule.ts as a repeatable job.
 * - runScheduledReports: Phase 3 item 2 — dispatched to the runner worker 3
 *   registers via registerScheduledReportsRunner(); throws loudly if none.
 * - sweepStuckPayrollRuns: Phase 2 item 1 — recover payroll runs stuck
 *   DRAFT/PROCESSING after a Redis outage or worker crash (requeue, or reset
 *   to DRAFT after the staleness timeout). Scheduled by schedule.ts.
 * - accrueMonthlyLeave: Phase 3 item 1 — monthly leave accrual per
 *   LeavePolicy.accrualPerMonth (delegates to leave-accrual.processor.ts).
 *
 * NOTE: the shared MaintenanceJobPayload type only names 'purgeExpiredAiLogs'
 * (owned by @ems/shared). This processor widens it locally rather than
 * editing shared — worker 3 / the coordinator can promote the union into
 * shared when the reports runner lands.
 */

export const AI_LOG_RETENTION_DAYS_DEFAULT = 90;

// Local widening of the shared payload: new operations this processor serves.
export type ExtendedMaintenanceJobPayload = Omit<MaintenanceJobPayload, 'operation'> & {
  operation:
    | 'purgeExpiredAiLogs'
    | 'markNightlyAbsences'
    | 'runScheduledReports'
    | 'sweepStuckPayrollRuns'
    | 'accrueMonthlyLeave';
};

export async function processMaintenance(job: Job<ExtendedMaintenanceJobPayload>) {
  const { operation, correlationId } = job.data;
  log.info('maintenance.start', { jobId: job.id, operation, correlationId });

  switch (operation) {
    case 'purgeExpiredAiLogs':
      return purgeExpiredAiLogs(job as Job<MaintenanceJobPayload>);
    case 'markNightlyAbsences':
      return markNightlyAbsences(job);
    case 'runScheduledReports': {
      const runner = getScheduledReportsRunner();
      if (!runner) {
        throw new Error(
          'runScheduledReports fired with no runner registered — worker 3 must call registerScheduledReportsRunner().',
        );
      }
      const outcome = await runner({
        correlationId: correlationId ?? `reports:${job.id}`,
        scheduledAt: new Date().toISOString(),
      });
      return { operation: 'runScheduledReports', outcome };
    }
    case 'sweepStuckPayrollRuns':
      return sweepStuckPayrollRuns(job);
    case 'accrueMonthlyLeave':
      return accrueMonthlyLeave(job as Job<{ correlationId?: string }>);
    default:
      throw new Error(`Unknown maintenance operation: ${String(operation)}`);
  }
}

export async function purgeExpiredAiLogs(job: Job<MaintenanceJobPayload>) {
  const retentionDays =
    job.data.retentionDays ?? Number(process.env.AI_LOG_RETENTION_DAYS || AI_LOG_RETENTION_DAYS_DEFAULT);

  // ONE gate, shared with the API's GDPR multi-entity purge (@ems/shared):
  // DRY-RUN BY DEFAULT. A real delete requires BOTH counsel sign-off
  // (GDPR_RETENTION_SIGNED_OFF=true) AND an explicit dryRun:false on the
  // job. An explicit dryRun:false without sign-off is forced back to
  // dry-run and logged loudly — the scheduled repeatable job never passes
  // dryRun, so it can never delete until counsel signs off.
  const signedOff = isRetentionSignedOff();
  const dryRun = !(signedOff && job.data.dryRun === false);
  if (job.data.dryRun === false && !signedOff) {
    log.warn('maintenance.purgeExpiredAiLogs.signoff-missing', {
      jobId: job.id,
      correlationId: job.data.correlationId,
      reason:
        `dryRun:false requested but counsel sign-off is not recorded ` +
        `(${RETENTION_SIGNOFF_ENV}!=true) — forcing DRY-RUN`,
    });
  }
  const mode = dryRun ? 'DRY-RUN — no rows deleted' : 'LIVE DELETE';

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`Invalid retention window: ${retentionDays} days.`);
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const matching = await prisma.aIRequestLog.count({ where: { createdAt: { lt: cutoff } } });

  log.info('maintenance.purgeExpiredAiLogs.scan', {
    jobId: job.id,
    retentionDays,
    cutoff: cutoff.toISOString(),
    matching,
    dryRun,
    signedOff,
    mode,
    correlationId: job.data.correlationId,
  });

  let deleted = 0;
  if (!dryRun && matching > 0) {
    const result = await prisma.aIRequestLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    deleted = result.count;
  }

  log.info('maintenance.purgeExpiredAiLogs.done', {
    jobId: job.id,
    matched: matching,
    deleted,
    dryRun,
    signedOff,
    mode,
  });

  return { operation: 'purgeExpiredAiLogs', retentionDays, dryRun, signedOff, matched: matching, deleted };
}

// ---------------------------------------------------------------------------
// Payroll sweep (Phase 2 item 1 — fail-loud enqueue recovery).
//
// The API now throws instead of silently dropping jobs when Redis is down,
// but a job can still be lost between "enqueue accepted" and "worker
// finished" (worker crash, deploy kill, Redis failover). This periodic sweep
// recovers the two stuck shapes:
//
//  1. PROCESSING runs older than PAYROLL_SWEEP_STALE_MINUTES (default 30):
//     the worker died mid-compute. Reset to DRAFT and requeue — the payroll
//     processor's payslip upserts make the recompute converge instead of
//     double-paying.
//  2. DRAFT runs older than the timeout with NO payslips: their compute job
//     was never (or unsuccessfully) enqueued. Requeue them. DRAFT runs that
//     already have payslips are awaiting maker/checker approval — NOT stuck,
//     deliberately skipped.
//
// The requeue uses the canonical idempotency key `payroll-run:<runId>`; if a
// live job with that key still exists BullMQ dedupes and the add is a safe
// no-op (logged, not fatal).
// ---------------------------------------------------------------------------

export const PAYROLL_SWEEP_STALE_MINUTES_DEFAULT = 30;

let payrollQueue: Queue | null = null;

function getPayrollQueue(): Queue {
  if (!payrollQueue) {
    payrollQueue = new Queue(QUEUE_NAMES.payroll, {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return payrollQueue;
}

async function requeuePayrollRun(
  payrollRunId: string,
  correlationId: string,
): Promise<boolean> {
  const jobId = `payroll-run:${payrollRunId}`;
  try {
    await getPayrollQueue().add(
      'process-payroll-run',
      { payrollRunId, idempotencyKey: jobId, correlationId },
      { jobId },
    );
    return true;
  } catch (e: any) {
    // Most likely a live job with the same idempotency key still exists —
    // the DB reset above is the important half; the existing job converges
    // via upserts. Loud log, not a sweep failure.
    log.warn('maintenance.sweep.requeue-skipped', {
      payrollRunId,
      jobId,
      error: e?.message,
    });
    return false;
  }
}

export async function sweepStuckPayrollRuns(job: Job<ExtendedMaintenanceJobPayload>) {
  const staleMinutes = Number(
    process.env.PAYROLL_SWEEP_STALE_MINUTES || PAYROLL_SWEEP_STALE_MINUTES_DEFAULT,
  );
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000);
  const correlationId = job.data.correlationId ?? `sweep:${job.id ?? Date.now()}`;

  log.info('maintenance.sweep.start', {
    jobId: job.id,
    staleMinutes,
    staleBefore: staleBefore.toISOString(),
    correlationId,
  });

  // 1. Stuck PROCESSING: reset to DRAFT, then requeue.
  const stuckProcessing = await prisma.payrollRun.findMany({
    where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
    select: { id: true, month: true, year: true },
  });

  let reset = 0;
  let requeued = 0;
  for (const run of stuckProcessing) {
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: { status: 'DRAFT' },
    });
    reset++;
    log.warn('maintenance.sweep.reset-processing', {
      payrollRunId: run.id,
      month: run.month,
      year: run.year,
      correlationId,
    });
    if (await requeuePayrollRun(run.id, correlationId)) requeued++;
  }

  // 2. Stuck DRAFT (never computed): requeue. Runs with payslips are
  //    awaiting approval — not stuck.
  const stuckDraft = await prisma.payrollRun.findMany({
    where: {
      status: 'DRAFT',
      createdAt: { lt: staleBefore },
      payslips: { none: {} },
    },
    select: { id: true, month: true, year: true },
  });

  for (const run of stuckDraft) {
    log.warn('maintenance.sweep.requeue-draft', {
      payrollRunId: run.id,
      month: run.month,
      year: run.year,
      correlationId,
    });
    if (await requeuePayrollRun(run.id, correlationId)) requeued++;
  }

  log.info('maintenance.sweep.done', {
    jobId: job.id,
    stuckProcessing: stuckProcessing.length,
    stuckDraft: stuckDraft.length,
    reset,
    requeued,
    correlationId,
  });

  return {
    operation: 'sweepStuckPayrollRuns',
    stuckProcessing: stuckProcessing.length,
    stuckDraft: stuckDraft.length,
    reset,
    requeued,
  };
}
