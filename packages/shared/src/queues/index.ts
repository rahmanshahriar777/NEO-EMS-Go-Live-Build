/**
 * Queue contract shared between the API (producer) and the BullMQ worker
 * (consumer). This is the canonical definition — `apps/api` and
 * `apps/worker` must both follow it (apps/api/src/core/queues/queue.constants.ts
 * currently duplicates these names; it should re-export from here).
 *
 * Queue names: short, stable, and provider-agnostic.
 */
export const QUEUE_NAMES = {
  payroll: 'payroll',
  notifications: 'notifications',
  ai: 'ai',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The worker also runs scheduled maintenance jobs (retention purges).
 * Kept separate from the business queues so maintenance backlog never
 * blocks payroll/notification/AI work.
 */
export const MAINTENANCE_QUEUE = 'maintenance' as const;

/**
 * Default job options applied by every producer. Typed structurally to match
 * BullMQ's `JobsOptions` without taking a bullmq dependency in shared.
 */
export interface DefaultJobOptions {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: number;
  removeOnFail: number;
}

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 1000,
};

/**
 * Convention: producers set `jobId` to make enqueue idempotent, e.g.
 * `payroll-run:<payrollRunId>`. The payroll processor additionally upserts
 * payslips, so retries are safe even if a duplicate slips through.
 */
export interface PayrollJobPayload {
  payrollRunId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface NotificationJobPayload {
  /**
   * Recipient USER id. Optional for email-only jobs addressed to raw
   * addresses (e.g. scheduled reports): when absent the worker skips the
   * in-app persist and the email channel hook resolves the recipient from
   * `data.email` only. Non-email channels still require it.
   */
  userId?: string;
  channel: 'in-app' | 'email' | 'sms';
  template: string;
  data: Record<string, any>;
  correlationId: string;
}

export interface AiJobPayload {
  requestId: string;
  prompt: string;
  options?: Record<string, any>;
  correlationId: string;
}

export interface MaintenanceJobPayload {
  /** Currently supported: 'purgeExpiredAiLogs'. */
  operation: 'purgeExpiredAiLogs';
  /** When true, count but do not delete. */
  dryRun?: boolean;
  /** Overrides AI_LOG_RETENTION_DAYS for this run. */
  retentionDays?: number;
  correlationId: string;
}
