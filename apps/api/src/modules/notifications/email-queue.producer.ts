import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { QueueUnavailableException } from '../../core/queues/queue-unavailable.exception';
import { getCorrelationId } from '../../common/correlation/correlation';

/**
 * Producer for the `email` queue (Phase 2 item 2).
 *
 * Contract: the worker owns the email provider and the consumer of the
 * `email` queue. This producer only enqueues; delivery is the worker's job
 * (its channel hook throws on delivery failure so BullMQ retries).
 *
 * Payload contract (keep in sync with the worker's consumer):
 *   { to, subject, text?, html?, template?, data?, correlationId }
 * Idempotency: callers should pass a stable `idempotencyKey`; re-enqueueing
 * the same logical email is then a safe no-op.
 *
 * Failure semantics (fail-loud, Phase 2 item 1): enqueue failures THROW a
 * typed QueueUnavailableException instead of returning null. This is safe
 * because the in-app notification row is ALWAYS persisted first
 * (NotificationsService.notify) — the in-app copy is the guaranteed
 * fallback, so a failed email-copy enqueue never loses the notification
 * itself.
 *
 * Correlation: when the caller does not pass an explicit correlationId, the
 * ambient request correlation (inbound `x-request-id`, via AsyncLocalStorage)
 * is used instead of minting a fresh UUID.
 */
export const EMAIL_QUEUE_NAME = 'email';

export interface EmailJobPayload {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  template?: string;
  data?: Record<string, any>;
  correlationId: string;
}

@Injectable()
export class EmailQueueProducer implements OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueProducer.name);
  private queue: Queue | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getQueue(): Queue {
    if (!this.queue) {
      this.queue = new Queue(EMAIL_QUEUE_NAME, {
        connection: {
          host: this.configService.get<string>('redis.host', 'localhost'),
          port: this.configService.get<number>('redis.port', 6379),
          password: this.configService.get<string>('redis.password') || undefined,
          // Required by BullMQ when sharing an ioredis connection.
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      });
      this.queue.on('error', (err) =>
        this.logger.warn(`Queue '${EMAIL_QUEUE_NAME}' error: ${err.message}`),
      );
    }
    return this.queue;
  }

  async onModuleDestroy() {
    try {
      await this.queue?.close();
    } catch (e: any) {
      this.logger.warn(`Failed to close queue '${EMAIL_QUEUE_NAME}': ${e.message}`);
    }
    this.queue = null;
  }

  /**
   * @throws QueueUnavailableException when the enqueue fails (Redis down).
   * The in-app notification (persisted by the caller before enqueueing)
   * remains as the guaranteed fallback.
   */
  async enqueueEmail(
    payload: Omit<EmailJobPayload, 'correlationId'>,
    correlationId?: string,
    idempotencyKey?: string,
  ): Promise<string> {
    const jobId = idempotencyKey ?? `email:${payload.to}:${Date.now()}:${randomUUID()}`;
    const resolvedCorrelationId = correlationId ?? getCorrelationId() ?? randomUUID();
    try {
      const job = await this.getQueue().add(
        'send-email',
        { ...payload, correlationId: resolvedCorrelationId } satisfies EmailJobPayload,
        { jobId },
      );
      const id = (job.id as string) ?? jobId;
      this.logger.log(`Enqueued email to ${payload.to} (jobId=${id})`);
      return id;
    } catch (e: any) {
      // Fail-loud: the email copy was NOT scheduled. The caller already
      // persisted the in-app notification, so nothing is lost — but the
      // failure must be visible (typed 503), not a silent null.
      this.logger.error(`Email enqueue failed for ${payload.to}: ${e.message}`);
      throw new QueueUnavailableException(EMAIL_QUEUE_NAME, 'send-email', jobId, e);
    }
  }
}
