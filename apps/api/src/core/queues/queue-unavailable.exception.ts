import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Fail-loud enqueue (Phase 2 item 1, go-live hardening).
 *
 * Thrown when a BullMQ enqueue fails — most commonly because Redis is
 * unreachable. The old fail-open behaviour (log a warning, return null) is
 * gone: a lost job must be VISIBLE to the caller, never silently dropped.
 *
 * Recovery paths:
 * - Payroll: the worker's periodic sweep (`sweepStuckPayrollRuns`) requeues
 *   runs left DRAFT/PROCESSING by a lost job.
 * - Email: the in-app notification row is persisted BEFORE the email copy is
 *   enqueued (NotificationsService.notify), so the notification itself is
 *   never lost when the email copy fails to enqueue.
 *
 * HTTP mapping: 503 Service Unavailable — the request itself was valid, a
 * backing dependency (Redis) is down.
 */
export class QueueUnavailableException extends HttpException {
  constructor(
    queueName: string,
    jobName: string,
    jobId: string,
    cause?: unknown,
  ) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          `Failed to enqueue job '${jobName}' on queue '${queueName}' ` +
          `(jobId=${jobId}): the job queue is unavailable. The foreground ` +
          `operation may have succeeded; the background job was NOT scheduled.`,
        error: 'QueueUnavailable',
        queue: queueName,
        job: jobName,
        jobId,
        cause: cause instanceof Error ? cause.message : String(cause ?? ''),
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'QueueUnavailableException';
  }
}
