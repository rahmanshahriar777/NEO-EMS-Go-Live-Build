import { randomUUID } from 'node:crypto';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '@ems/database';
import {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  RETENTION_SIGNOFF_ENV,
  isRetentionSignedOff,
  type MaintenanceJobPayload,
} from '@ems/shared';
import { MinioVaultClient, loadMinioConfigFromEnv } from '@ems/storage';
import { log } from '../logger.js';
import { appendWorkerAuditLog } from '../lib/worker-audit.js';
import { markNightlyAbsences } from './attendance.processor.js';
import { accrueMonthlyLeave } from './leave-accrual.processor.js';
import { getScheduledReportsRunner } from '../schedule.js';

let maintenanceRedis: Redis | null = null;
let cachedMaintenanceVault: MinioVaultClient | null = null;

export function setMaintenanceRedis(connection: Redis): void {
  maintenanceRedis = connection;
}

function getMaintenanceVault(): MinioVaultClient {
  if (!cachedMaintenanceVault) {
    cachedMaintenanceVault = new MinioVaultClient(loadMinioConfigFromEnv());
  }
  return cachedMaintenanceVault;
}

function getMaintenanceRedis(): Redis | null {
  return maintenanceRedis;
}

/**
 * Return true when a BullMQ job with the given jobId is currently in the
 * 'active' state (i.e. being processed by a worker right now).
 *
 * This is used by the payroll sweep to distinguish a genuinely stuck
 * PROCESSING run (worker died) from a legitimately long-running one.
 * If the queue is unreachable we conservatively return true (assume active)
 * so the sweep never aborts a live run during a Redis hiccup.
 */
async function isJobActive(queue: Queue, jobId: string): Promise<boolean> {
  try {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    const state = await job.getState();
    return state === 'active';
  } catch (e: any) {
    // Can't determine — assume it could be active to be safe.
    log.warn('maintenance.sweep.active-check-failed', { jobId, error: e?.message });
    return true;
  }
}

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

export const FIELD_REPORT_RETENTION_DAYS_DEFAULT = 1095;

// Local widening of the shared payload: new operations this processor serves.
export type ExtendedMaintenanceJobPayload = Omit<MaintenanceJobPayload, 'operation'> & {
  operation:
    | 'purgeExpiredAiLogs'
    | 'purgeAbandonedFieldUploads'
    | 'purgeExpiredFieldReports'
    | 'flushFieldReportPreviewAudit'
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
    case 'purgeAbandonedFieldUploads':
      return purgeAbandonedFieldUploads(job as Job<MaintenanceJobPayload>);
    case 'purgeExpiredFieldReports':
      return purgeExpiredFieldReports(job as Job<MaintenanceJobPayload>);
    case 'flushFieldReportPreviewAudit':
      return flushFieldReportPreviewAudit(job as Job<MaintenanceJobPayload>);
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

  // 1. Stuck PROCESSING: reset to DRAFT and requeue, BUT only when there is
  //    no active BullMQ job for the run. A job is still active when the
  //    processor is running a legitimately long computation (large payroll)
  //    — resetting that run mid-flight would cause a double-compute on the
  //    next sweep iteration. Only truly orphaned runs (no active job AND
  //    past the stale window) are recovered.
  const stuckProcessingCandidates = await prisma.payrollRun.findMany({
    where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
    select: { id: true, month: true, year: true },
  });

  let reset = 0;
  let requeued = 0;
  let skippedActive = 0;
  for (const run of stuckProcessingCandidates) {
    const jobIdColon = `payroll-run:${run.id}`;
    const jobIdHyphen = `payroll-run-${run.id}`;
    const active =
      (await isJobActive(getPayrollQueue(), jobIdColon)) ||
      (await isJobActive(getPayrollQueue(), jobIdHyphen));
    if (active) {
      // Job is still processing — leave it alone.
      skippedActive++;
      log.info('maintenance.sweep.skip-active', {
        payrollRunId: run.id,
        month: run.month,
        year: run.year,
        jobId: jobIdColon,
        correlationId,
      });
      continue;
    }
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
    stuckProcessingCandidates: stuckProcessingCandidates.length,
    skippedActive,
    stuckDraft: stuckDraft.length,
    reset,
    requeued,
    correlationId,
  });

  return {
    operation: 'sweepStuckPayrollRuns',
    stuckProcessingCandidates: stuckProcessingCandidates.length,
    skippedActive,
    stuckDraft: stuckDraft.length,
    reset,
    requeued,
  };
}

/**
 * Cleans up expired/abandoned Field Reporting multipart upload sessions and their
 * staging part objects in MinIO (belt-and-braces alongside the 1-day MinIO ILM rule).
 */
export async function purgeAbandonedFieldUploads(
  job: Job<MaintenanceJobPayload>,
  deps?: { vault?: Pick<MinioVaultClient, 'removeObjects'> },
) {
  const now = new Date();
  const deleteOlderThan = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const expiredSessions = await prisma.fieldReportUploadSession.findMany({
    where: {
      OR: [
        { status: 'OPEN', expiresAt: { lt: now } },
        { status: { in: ['ABORTED', 'EXPIRED'] }, updatedAt: { lt: deleteOlderThan } },
      ],
    },
    take: 200,
  });

  if (expiredSessions.length === 0) {
    return { operation: 'purgeAbandonedFieldUploads', expiredMarked: 0, deletedSessions: 0, cleanedParts: 0 };
  }

  let vault: Pick<MinioVaultClient, 'removeObjects'> | null = deps?.vault ?? null;
  if (!vault && process.env.S3_ACCESS_KEY) {
    try {
      vault = getMaintenanceVault();
    } catch {
      vault = null;
    }
  }

  let cleanedParts = 0;
  let expiredMarked = 0;
  const deletableIds: string[] = [];

  for (const s of expiredSessions) {
    const partKeys = (s.uploadedChunks || []).map(
      (idx) => `${s.stagingKeyPrefix}/part-${String(idx).padStart(5, '0')}`,
    );
    if (partKeys.length > 0 && vault) {
      await vault.removeObjects(partKeys).catch((err: any) => {
        log.warn('maintenance.field-uploads.remove-parts-failed', {
          sessionId: s.id,
          error: err?.message,
        });
      });
      cleanedParts += partKeys.length;
    }

    if (s.status === 'OPEN') {
      await prisma.fieldReportUploadSession.update({
        where: { id: s.id },
        data: { status: 'EXPIRED' },
      });
      expiredMarked += 1;
    } else if (s.updatedAt < deleteOlderThan) {
      deletableIds.push(s.id);
    }
  }

  let deletedSessions = 0;
  if (deletableIds.length > 0) {
    const res = await prisma.fieldReportUploadSession.deleteMany({
      where: { id: { in: deletableIds } },
    });
    deletedSessions = res.count;
  }

  log.info('maintenance.purgeAbandonedFieldUploads.done', {
    jobId: job.id,
    expiredMarked,
    deletedSessions,
    cleanedParts,
    correlationId: job.data.correlationId,
  });

  return { operation: 'purgeAbandonedFieldUploads', expiredMarked, deletedSessions, cleanedParts };
}

/**
 * Drains hourly preview-view counters from Redis (`fr:preview_agg:<YYYY-MM-DD>`) into
 * condensed hash-chained `AuditLog` entries so thumbnail/lightbox browsing never creates
 * `pg_advisory_xact_lock` contention on high-volume dashboards.
 */
export async function flushFieldReportPreviewAudit(
  job: Job<MaintenanceJobPayload>,
  deps?: {
    redis?: Pick<Redis, 'keys' | 'rename' | 'hgetall' | 'del'>;
    auditWriter?: typeof appendWorkerAuditLog;
  },
) {
  const r = deps?.redis ?? getMaintenanceRedis();
  const writeAudit = deps?.auditWriter ?? appendWorkerAuditLog;
  if (!r) {
    log.warn('maintenance.flushFieldReportPreviewAudit.no-redis', { jobId: job.id });
    return { operation: 'flushFieldReportPreviewAudit', flushedBuckets: 0, auditRowsWritten: 0 };
  }

  const allKeys = await r.keys('fr:preview_agg:*');
  const liveKeys = allKeys.filter((k) => !k.includes(':flushing:'));
  let flushedBuckets = 0;
  let auditRowsWritten = 0;

  for (const key of liveKeys) {
    const dayKey = key.replace('fr:preview_agg:', '');
    const flushingKey = `${key}:flushing:${randomUUID()}`;
    try {
      await r.rename(key, flushingKey);
    } catch {
      continue;
    }

    const entries = await r.hgetall(flushingKey);
    const byUser = new Map<string, Array<{ reportId: string; count: number }>>();

    for (const [field, rawCount] of Object.entries(entries)) {
      const sep = field.indexOf(':');
      if (sep <= 0) continue;
      const userId = field.slice(0, sep);
      const reportId = field.slice(sep + 1);
      const count = parseInt(rawCount, 10) || 0;
      if (count <= 0) continue;
      const arr = byUser.get(userId) ?? [];
      arr.push({ reportId, count });
      byUser.set(userId, arr);
    }

    for (const [userId, views] of byUser.entries()) {
      const totalViews = views.reduce((s, v) => s + v.count, 0);
      await writeAudit({
        actorId: userId,
        action: 'READ' as any,
        entityType: 'FIELD_REPORT_PREVIEW_BATCH',
        entityId: `${dayKey}:${userId}`,
        afterState: {
          day: dayKey,
          reportCount: views.length,
          totalViews,
          reportViews: views,
        },
      });
      auditRowsWritten += 1;
    }

    await r.del(flushingKey);
    flushedBuckets += 1;
  }

  log.info('maintenance.flushFieldReportPreviewAudit.done', {
    jobId: job.id,
    flushedBuckets,
    auditRowsWritten,
    correlationId: job.data.correlationId,
  });

  return { operation: 'flushFieldReportPreviewAudit', flushedBuckets, auditRowsWritten };
}

/**
 * Retention purge for expired operational Field Reports. Strictly DRY-RUN by default
 * unless BOTH `GDPR_RETENTION_SIGNED_OFF=true` AND `job.data.dryRun === false`.
 * Always preserves `legalHold === true` and `INCIDENT_SAFETY` reports unless explicitly
 * past statutory holding rules and never deletes DB rows before S3 objects are removed.
 */
export async function purgeExpiredFieldReports(
  job: Job<MaintenanceJobPayload>,
  deps?: {
    vault?: Pick<MinioVaultClient, 'removeObjects'>;
    auditWriter?: typeof appendWorkerAuditLog;
  },
) {
  const retentionDays =
    job.data.retentionDays ??
    Number(process.env.FIELD_REPORT_RETENTION_DAYS || FIELD_REPORT_RETENTION_DAYS_DEFAULT);

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`Invalid retention window: ${retentionDays} days.`);
  }

  const signedOff = isRetentionSignedOff();
  const dryRun = !(signedOff && job.data.dryRun === false);
  if (job.data.dryRun === false && !signedOff) {
    log.warn('maintenance.purgeExpiredFieldReports.signoff-missing', {
      jobId: job.id,
      correlationId: job.data.correlationId,
      reason: `dryRun:false requested but counsel sign-off missing (${RETENTION_SIGNOFF_ENV}!=true)`,
    });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const candidates = await prisma.fieldReport.findMany({
    where: {
      legalHold: false,
      category: { not: 'INCIDENT_SAFETY' },
      OR: [
        { retentionExpiresAt: { lt: now } },
        { deletedAt: { not: null, lt: cutoff } },
        { retentionExpiresAt: null, deletedAt: null, updatedAt: { lt: cutoff } },
      ],
    },
    take: 100,
    include: {
      attachments: {
        include: { derivatives: true },
      },
    },
  });

  const storageKeys: string[] = [];
  for (const r of candidates) {
    for (const att of r.attachments) {
      storageKeys.push(att.storageKey);
      for (const deriv of att.derivatives) {
        storageKeys.push(deriv.storageKey);
      }
    }
  }

  let deletedReports = 0;
  let deletedObjects = 0;

  if (!dryRun && candidates.length > 0) {
    const vault = deps?.vault ?? getMaintenanceVault();
    if (storageKeys.length > 0) {
      await vault.removeObjects(storageKeys);
      deletedObjects = storageKeys.length;
    }
    const ids = candidates.map((c) => c.id);
    const delRes = await prisma.fieldReport.deleteMany({
      where: { id: { in: ids }, legalHold: false },
    });
    deletedReports = delRes.count;

    const writeAudit = deps?.auditWriter ?? appendWorkerAuditLog;
    await writeAudit({
      action: 'DELETE' as any,
      entityType: 'FIELD_REPORT_RETENTION_PURGE',
      entityId: `retention-${now.toISOString().slice(0, 10)}`,
      afterState: {
        retentionDays,
        deletedReports,
        deletedObjects,
        correlationId: job.data.correlationId,
      },
    });
  }

  log.info('maintenance.purgeExpiredFieldReports.done', {
    jobId: job.id,
    dryRun,
    signedOff,
    matched: candidates.length,
    matchedObjects: storageKeys.length,
    deletedReports,
    deletedObjects,
  });

  return {
    operation: 'purgeExpiredFieldReports',
    retentionDays,
    dryRun,
    signedOff,
    matched: candidates.length,
    deleted: deletedReports,
    deletedObjects,
  };
}
