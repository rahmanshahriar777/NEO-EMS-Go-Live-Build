import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  QueueName,
  PayrollJobPayload,
  NotificationJobPayload,
  AiJobPayload,
} from './queue.constants';
import { QueueUnavailableException } from './queue-unavailable.exception';
import { getCorrelationId } from '../../common/correlation/correlation';

export { QueueUnavailableException } from './queue-unavailable.exception';

/**
 * BullMQ producer for the API.
 *
 * The API never processes jobs itself; it only enqueues them. `jobId` is
 * always the idempotency key so re-enqueueing the same logical job is a safe
 * no-op.
 *
 * FAIL-LOUD (Phase 2 item 1, go-live hardening): enqueue failures THROW a
 * typed QueueUnavailableException (503) instead of returning null. The old
 * fail-open behaviour silently lost payroll/email jobs on a Redis outage;
 * callers now see the failure and can react. Recovery:
 *   - payroll runs stuck DRAFT/PROCESSING are requeued by the worker's
 *     periodic sweep (`sweepStuckPayrollRuns`);
 *   - notification jobs (incl. channel 'email' copies) are persisted in-app
 *     by the worker before the channel hook runs; if the enqueue itself
 *     fails, NotificationsService.notify persists the in-app row directly
 *     as the guaranteed fallback.
 *
 * Correlation: when the caller does not pass an explicit correlationId, the
 * ambient request correlation (inbound `x-request-id`, via AsyncLocalStorage)
 * is used instead of minting a fresh UUID — worker logs join back to the
 * originating HTTP request. Outside a request context a UUID is minted.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly configService: ConfigService) {}

  private getQueue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: {
          host: this.configService.get<string>('redis.host', 'localhost'),
          port: this.configService.get<number>('redis.port', 6379),
          password: this.configService.get<string>('redis.password'),
          // Required by BullMQ when sharing an ioredis connection.
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      queue.on('error', (err) =>
        this.logger.warn(`Queue '${name}' error: ${err.message}`),
      );
      this.queues.set(name, queue);
    }
    return queue;
  }

  async onModuleDestroy() {
    for (const [name, queue] of this.queues) {
      try {
        await queue.close();
      } catch (e: any) {
        this.logger.warn(`Failed to close queue '${name}': ${e.message}`);
      }
    }
    this.queues.clear();
  }

  /**
   * Resolve the correlation ID for an enqueue: explicit > ambient request
   * (x-request-id via AsyncLocalStorage) > minted UUID.
   */
  private resolveCorrelationId(explicit?: string): string {
    return explicit ?? getCorrelationId() ?? randomUUID();
  }

  /**
   * Enqueue background processing for a payroll run (e.g. payslip generation,
   * ledger export). Idempotency key: `payroll-run:<runId>`.
   *
   * @throws QueueUnavailableException when the enqueue fails (Redis down).
   */
  async enqueuePayrollRun(
    payrollRunId: string,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<string> {
    const jobId = idempotencyKey ?? `payroll-run:${payrollRunId}`;
    const payload: PayrollJobPayload = {
      payrollRunId,
      idempotencyKey: jobId,
      correlationId: this.resolveCorrelationId(correlationId),
    };
    return this.enqueue(QUEUE_NAMES.PAYROLL, 'process-payroll-run', payload, jobId);
  }

  /**
   * Enqueue a templated notification for a user. Callers SHOULD pass a stable
   * idempotency key (e.g. `payslip-ready:<payslipId>`) so retries never
   * double-notify.
   *
   * `userId` may be omitted for email-only jobs to raw addresses (scheduled
   * reports): the worker then skips the in-app persist and the email channel
   * hook resolves the recipient from `data.email`.
   *
   * @throws QueueUnavailableException when the enqueue fails (Redis down).
   */
  async enqueueNotification(
    userId: string | undefined,
    channel: NotificationJobPayload['channel'],
    template: string,
    data: Record<string, any>,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<string> {
    const jobId = idempotencyKey ?? `notification:${userId ?? 'email-only'}:${template}:${randomUUID()}`;
    const payload: NotificationJobPayload = {
      userId,
      channel,
      template,
      data,
      correlationId: this.resolveCorrelationId(correlationId),
    };
    return this.enqueue(QUEUE_NAMES.NOTIFICATIONS, 'send-notification', payload, jobId);
  }

  /**
   * Enqueue an AI generation job for async processing by the worker.
   * Idempotency key: `ai-request:<requestId>`.
   *
   * Consumed by the worker's AI processor (`apps/worker/src/processors/ai.processor.ts`).
   *
   * @throws QueueUnavailableException when the enqueue fails (Redis down).
   */
  async enqueueAi(
    requestId: string,
    prompt: string,
    options: Record<string, any> | undefined,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<string> {
    const jobId = idempotencyKey ?? `ai-request:${requestId}`;
    const payload: AiJobPayload = {
      requestId,
      prompt,
      options,
      correlationId: this.resolveCorrelationId(correlationId),
    };
    return this.enqueue(QUEUE_NAMES.AI, 'ai-generate', payload, jobId);
  }

  private async enqueue(
    queueName: QueueName,
    jobName: string,
    payload: PayrollJobPayload | NotificationJobPayload | AiJobPayload,
    jobId: string,
  ): Promise<string> {
    const sanitizedJobId = jobId ? jobId.replace(/:/g, '-') : undefined;
    try {
      const job = await this.getQueue(queueName).add(jobName, payload, {
        ...DEFAULT_JOB_OPTIONS,
        ...(sanitizedJobId ? { jobId: sanitizedJobId } : {}),
      });
      const id = job.id ?? sanitizedJobId ?? jobId;
      this.logger.log(
        `Enqueued job '${jobName}' on queue '${queueName}' (jobId=${id})`,
      );
      return id;
    } catch (e: any) {
      // Fail-LOUD: the job was NOT scheduled. Throw a typed error so the
      // caller (and the operator reading the 503) can see it and the
      // recovery paths (payroll sweep, in-app notification fallback) engage.
      this.logger.error(
        `Failed to enqueue job '${jobName}' on queue '${queueName}' (jobId=${jobId}): ${e.message}`,
      );
      throw new QueueUnavailableException(queueName, jobName, jobId, e);
    }
  }
}
