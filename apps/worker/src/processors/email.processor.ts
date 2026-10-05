import { prisma } from '@ems/database';
import type { NotificationJobPayload } from '@ems/shared';
import { log } from '../logger.js';
import { renderTemplate } from '../email/templates.js';
import { resolveSmtpConfig, sendSmtp } from '../email/smtp-sender.js';
import type { ChannelHook } from './notification.processor.js';

/**
 * Email channel hook for the notification processor (Phase 1 B2).
 *
 * Registered in main.ts via registerChannelHook('email', sendEmailChannelHook).
 * Flow: resolve recipient address (job data override, else the user's email)
 * → render template → send via the shared SMTP provider when configured.
 *
 * FAILURE SEMANTICS (Phase 2 item 2, go-live hardening):
 * - SMTP transport failure (transient) → THROWS, so the notification
 *   processor lets BullMQ retry with backoff. The in-app notification row is
 *   already persisted as the guaranteed fallback.
 * - No recipient address (permanent) → returns `failed`; the processor still
 *   throws (uniform channel-failure semantics) and the job lands in the DLQ
 *   for operator inspection after retries.
 *
 * Disabled-SMTP behaviour: when SMTP_HOST is unset (dev), the rendered email
 * is logged and reported as `not_configured` — it is NEVER reported as sent.
 * The in-app notification record (persisted by processNotification) remains
 * the guaranteed delivery.
 */
export const sendEmailChannelHook: ChannelHook = async (payload: NotificationJobPayload) => {
  const { userId, template, data, correlationId } = payload;

  // Recipient: explicit override wins (e.g. invitation to a not-yet-user);
  // otherwise the linked user's account email.
  let to: string | undefined = data?.email ? String(data.email) : undefined;
  if (!to && userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    to = user?.email;
  }
  if (!to) {
    return {
      channel: 'email',
      status: 'failed',
      detail: 'No recipient address: job data had no email and the user has no account email.',
    };
  }

  const rendered = renderTemplate(template, { ...(data ?? {}), email: to });

  const smtp = resolveSmtpConfig();
  if (!smtp) {
    log.info('email.dev-log', {
      to,
      template,
      subject: rendered.subject,
      body: rendered.text,
      correlationId,
      note: 'SMTP_HOST unset — email logged, not sent.',
    });
    return {
      channel: 'email',
      status: 'not_configured',
      detail: 'SMTP_HOST is not set; email content logged to the worker log instead of being sent.',
    };
  }

  try {
    await sendSmtp(smtp, { to, subject: rendered.subject, text: rendered.text, html: rendered.html });
  } catch (err: any) {
    // Fail-LOUD: transient SMTP failure must throw so BullMQ retries (Phase
    // 2 item 2). The notification processor converts this to a `failed`
    // channel result and rethrows for the retry. The in-app copy is already
    // persisted — nothing is lost if all retries exhaust (job → DLQ).
    log.error('email.send.failed', { to, template, error: err?.message, correlationId });
    throw new Error(`Email channel failed for ${to}: ${err?.message || 'SMTP send failed'}`);
  }

  log.info('email.send.delivered', { to, template, subject: rendered.subject, correlationId });
  return { channel: 'email', status: 'delivered', detail: `sent to ${to}` };
};
