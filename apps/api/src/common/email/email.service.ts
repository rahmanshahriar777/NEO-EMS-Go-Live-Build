import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../core/queues/queue.service';
import {
  EMAIL_TITLES,
  EmailTemplateName,
  EmailTemplateData,
} from './email-templates';

/**
 * B2 — transactional email facade.
 *
 * The API NEVER sends email synchronously. This service enqueues a job on
 * the `notifications` queue (channel 'email'); the worker's notification
 * processor persists the in-app record and its email channel hook renders
 * the template (worker-side `email/templates.ts`) and delivers via the
 * shared SMTP provider (log fallback in dev).
 *
 * Payload contract (keep in sync with the worker's email channel hook):
 *   { email, title, ...templateData }  with `template` = one of
 *   'invitation' | 'verification' | 'password-reset' | 'payslip-ready'.
 * The recipient override `email` wins over the job's userId lookup — required
 * for invitations addressed to not-yet-users.
 *
 * NOTE on the queue contract: the notification job requires a `userId`
 * (worker 3 owns that processor). For emails addressed to someone who has no
 * user row yet (invitation), the caller's user id (e.g. the inviting HR admin)
 * is passed as the routing key and the recipient travels in `data.email`.
 * Callers MUST pass an idempotencyKey (e.g. `invitation:<tokenHash>`) so
 * retries never double-send.
 *
 * FAIL-LOUD (Phase 2 item 1): the enqueue THROWS QueueUnavailableException
 * when Redis is down instead of returning null. There is no silent path
 * where the email is lost: callers that need a guaranteed fallback should
 * persist their own record (NotificationsService.notify does) before calling
 * here, or catch the exception and surface the resend flow.
 */
export interface SendTemplatedEmailOptions {
  /** Recipient address (worker resolves `data.email` first). */
  to: string;
  /**
   * Routing user id for the notification job. For user-bound emails pass the
   * recipient's user id; for invitation emails pass the inviter's id.
   */
  userId: string;
  template: EmailTemplateName;
  /** Template data per the worker's documented contract (see email-templates.ts). */
  data: EmailTemplateData;
  /** Stable idempotency key — required so retries never double-send. */
  idempotencyKey: string;
  correlationId?: string;
  /** Short title stored on the in-app notification record (worker side). */
  title?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly queueService: QueueService) {}

  /**
   * Enqueue the templated email.
   *
   * @throws QueueUnavailableException when the notifications queue is
   * unreachable (Redis down) — fail-loud, Phase 2 item 1. The caller decides
   * whether to catch (e.g. invitation flow surfaces the resend path) or let
   * the 503 propagate.
   */
  async sendTemplated(options: SendTemplatedEmailOptions): Promise<string> {
    // correlationId: explicit > ambient request (x-request-id via
    // AsyncLocalStorage) > minted. Passing undefined lets the queue service
    // resolve the ambient request ID instead of minting a fresh UUID.
    const jobId = await this.queueService.enqueueNotification(
      options.userId,
      'email',
      options.template,
      {
        email: options.to,
        title: options.title ?? EMAIL_TITLES[options.template],
        ...options.data,
      },
      options.correlationId,
      options.idempotencyKey,
    );

    this.logger.log(
      `Email '${options.template}' queued for ${options.to} (job ${jobId})`,
    );
    return jobId;
  }
}
