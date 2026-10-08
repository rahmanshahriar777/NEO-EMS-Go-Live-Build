import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { QueueService } from '../../core/queues/queue.service';
import {
  EMAIL_TITLES,
  EmailTemplateName,
  EmailTemplateData,
  renderEmailTemplate,
} from './email-templates';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';

/**
 * B2 — transactional email facade.
 *
 * Primary delivery path: enqueues a job on the `notifications` BullMQ queue
 * (channel 'email'); the background worker persists the in-app record and its
 * email channel hook renders the template and delivers via the shared SMTP provider.
 *
 * High-Availability Fallback: if the background queue is unreachable (e.g. Redis
 * downtime or standalone/embedded mode without a worker), this service catches the
 * queue error and dispatches directly via the injected EmailProvider (Zoho SMTP),
 * ensuring critical workflows like User Invitations NEVER fail silently.
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

  constructor(
    private readonly queueService: QueueService,
    @Optional() @Inject(EMAIL_PROVIDER) private readonly emailProvider?: EmailProvider,
  ) {}

  /**
   * Enqueue or directly deliver the templated email.
   *
   * @throws QueueUnavailableException or Error if both the queue and direct fallback fail.
   */
  async sendTemplated(options: SendTemplatedEmailOptions): Promise<string> {
    try {
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
    } catch (queueErr: any) {
      if (this.emailProvider) {
        this.logger.warn(
          `Queue dispatch failed for email '${options.template}' to ${options.to}: ${queueErr.message}. Falling back to direct delivery via email provider '${this.emailProvider.name}'...`,
        );

        try {
          const rendered = renderEmailTemplate(options.template, {
            ...options.data,
            name: (options.data as any)?.name,
          });

          const subject = options.title ?? rendered.subject ?? EMAIL_TITLES[options.template];
          await this.emailProvider.send({
            to: options.to,
            subject,
            text: rendered.text,
            html: rendered.html,
          });

          const directJobId = `direct-${Date.now()}`;
          this.logger.log(
            `Email '${options.template}' successfully delivered directly to ${options.to} via ${this.emailProvider.name} (fallbackId: ${directJobId})`,
          );
          return directJobId;
        } catch (directErr: any) {
          this.logger.error(
            `Direct email dispatch fallback also failed for ${options.to} (${options.template}): ${directErr.message}`,
            directErr.stack,
          );
          throw directErr;
        }
      }

      this.logger.error(
        `Failed to queue email '${options.template}' for ${options.to} and no direct email provider available: ${queueErr.message}`,
      );
      throw queueErr;
    }
  }
}

