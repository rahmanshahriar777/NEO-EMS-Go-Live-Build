import { Queue } from 'bullmq';
import { MAINTENANCE_QUEUE } from '@ems/shared';
import { log } from './logger.js';

/**
 * Repeatable (cron-like) job setup for the worker (Phases 2–3).
 *
 * Called once from main.ts bootstrap after the queue handles exist. Uses
 * stable `jobId`s so re-running setup (e.g. after a deploy restart) does not
 * create duplicate repeatable entries — BullMQ dedupes the repeatable
 * scheduler entry by name+repeat key, and the fixed jobId keeps that stable.
 *
 * Schedule (timezone from SCHEDULE_TZ, default UTC):
 *   - nightly absence marking (Phase 2 item 5):  02:00 daily
 *   - retention purge (existing purge service):  03:00 daily
 *   - payroll sweep (Phase 2 item 1):            every 15 min (PAYROLL_SWEEP_CRON)
 *   - leave accrual (Phase 3 item 1):           01:00 on the 1st (LEAVE_ACCRUAL_CRON)
 *   - scheduled reports (Phase 3 item 2):        06:00 Mondays, ONLY once
 *     worker 3 registers runScheduledReports() via registerScheduledReportsRunner().
 */
export type ScheduledReportsRunner = (payload: {
  correlationId: string;
  scheduledAt: string;
}) => Promise<unknown>;

let reportsRunner: ScheduledReportsRunner | null = null;

/**
 * Worker 3 calls this at worker boot once `runScheduledReports()` exists.
 * Until then the scheduled-reports repeatable job is simply not created.
 */
export function registerScheduledReportsRunner(fn: ScheduledReportsRunner): void {
  reportsRunner = fn;
  log.info('schedule.reports.runner-registered', {});
}

export function getScheduledReportsRunner(): ScheduledReportsRunner | null {
  return reportsRunner;
}

const REPEAT_DEFAULTS = { removeOnComplete: 10, removeOnFail: 100 };

export async function setupRepeatableJobs(queues: Record<string, Queue>): Promise<void> {
  const maintenance = queues[MAINTENANCE_QUEUE];
  if (!maintenance) {
    log.warn('schedule.setup.skipped', { reason: `queue '${MAINTENANCE_QUEUE}' not initialised` });
    return;
  }

  const tz = process.env.SCHEDULE_TZ || 'UTC';
  const correlationId = `schedule:${new Date().toISOString()}`;

  // Phase 2 item 5 — nightly absence marking.
  await maintenance.add(
    'nightly-absence-marking',
    { operation: 'markNightlyAbsences', correlationId },
    { repeat: { pattern: '0 2 * * *', tz }, jobId: 'repeat:nightly-absence-marking', ...REPEAT_DEFAULTS },
  );

  // Retention-purge scheduling hook — calls the existing purge service method
  // (processMaintenance 'purgeExpiredAiLogs'). Dry-run vs real delete is
  // governed by the processor's env defaults (AI_PURGE_DRY_RUN).
  await maintenance.add(
    'retention-purge',
    { operation: 'purgeExpiredAiLogs', correlationId },
    { repeat: { pattern: '0 3 * * *', tz }, jobId: 'repeat:retention-purge', ...REPEAT_DEFAULTS },
  );

  // Phase 2 item 1 — payroll sweep: recover runs stuck DRAFT/PROCESSING
  // after a Redis outage or worker crash (requeue / reset to DRAFT).
  await maintenance.add(
    'payroll-sweep',
    { operation: 'sweepStuckPayrollRuns', correlationId },
    {
      repeat: { pattern: process.env.PAYROLL_SWEEP_CRON || '*/15 * * * *', tz },
      jobId: 'repeat:payroll-sweep',
      ...REPEAT_DEFAULTS,
    },
  );

  // Phase 3 item 1 — monthly leave accrual per LeavePolicy.accrualPerMonth.
  // Idempotent per (year, month) via a Redis completion marker; a policy
  // added mid-month takes effect from the next run.
  await maintenance.add(
    'leave-accrual',
    { operation: 'accrueMonthlyLeave', correlationId },
    {
      repeat: { pattern: process.env.LEAVE_ACCRUAL_CRON || '0 1 1 * *', tz },
      jobId: 'repeat:leave-accrual',
      ...REPEAT_DEFAULTS,
    },
  );

  // Phase 3 item 2 — scheduled reports. Only scheduled when worker 3 has
  // registered its runner; the maintenance processor throws loudly if the
  // job ever fires without one.
  if (getScheduledReportsRunner()) {
    await maintenance.add(
      'scheduled-reports',
      { operation: 'runScheduledReports', correlationId },
      { repeat: { pattern: '0 6 * * 1', tz }, jobId: 'repeat:scheduled-reports', ...REPEAT_DEFAULTS },
    );
  } else {
    log.info('schedule.reports.skipped', {
      reason: 'no scheduled-reports runner registered; worker 3 will call registerScheduledReportsRunner()',
    });
  }

  log.info('schedule.repeatable.ready', { tz, queues: [MAINTENANCE_QUEUE] });
}
