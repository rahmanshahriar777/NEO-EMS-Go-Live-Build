import { JobsOptions } from 'bullmq';
import {
  QUEUE_NAMES as SHARED_QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS as SHARED_DEFAULT_JOB_OPTIONS,
} from '@ems/shared';

/**
 * Queue names shared between the API (producer) and the worker (consumer).
 * Values are derived from the canonical contract in `@ems/shared` so the two
 * sides cannot drift; the UPPER_CASE key style is kept for existing call sites.
 */
export const QUEUE_NAMES = {
  PAYROLL: SHARED_QUEUE_NAMES.payroll,
  NOTIFICATIONS: SHARED_QUEUE_NAMES.notifications,
  AI: SHARED_QUEUE_NAMES.ai,
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Default job options for every job the API enqueues, per the queue contract:
 * 5 attempts, exponential backoff starting at 5s, bounded completed/failed sets.
 * Values come from `@ems/shared`; the bullmq `JobsOptions` typing is applied here.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: SHARED_DEFAULT_JOB_OPTIONS.attempts,
  backoff: {
    type: 'exponential',
    delay: SHARED_DEFAULT_JOB_OPTIONS.backoff.delay,
  },
  removeOnComplete: SHARED_DEFAULT_JOB_OPTIONS.removeOnComplete,
  removeOnFail: SHARED_DEFAULT_JOB_OPTIONS.removeOnFail,
};

// ---------------------------------------------------------------------------
// Job payload contracts (producer <-> worker)
// ---------------------------------------------------------------------------

export interface PayrollJobPayload {
  payrollRunId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface NotificationJobPayload {
  userId: string;
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
