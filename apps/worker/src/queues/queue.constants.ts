/**
 * @deprecated Import the queue contract from '@ems/shared' instead.
 * This shim re-exports the canonical contract so any lingering imports of
 * this path keep working during the migration.
 */
export {
  QUEUE_NAMES,
  MAINTENANCE_QUEUE,
  DEFAULT_JOB_OPTIONS,
} from '@ems/shared';
export type {
  QueueName,
  DefaultJobOptions,
  PayrollJobPayload,
  NotificationJobPayload,
  AiJobPayload,
  MaintenanceJobPayload,
} from '@ems/shared';
