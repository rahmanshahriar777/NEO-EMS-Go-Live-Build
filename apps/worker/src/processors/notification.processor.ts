import { Job } from 'bullmq';
import { prisma } from '@ems/database';
import type { NotificationJobPayload } from '@ems/shared';
import { log } from '../logger.js';

/**
 * Notification processor: persist + dispatch.
 *
 * The in-app record in `notifications` is always persisted first — it is the
 * source of truth the dashboard reads. External channels (email/SMS) go
 * through registered hooks. This processor NEVER claims a message was "sent"
 * unless a hook confirms it: unconfigured channels are reported honestly as
 * `not_configured` so nobody mistakes a log line for a delivery.
 *
 * RETRY SEMANTICS (Phase 2 item 2, go-live hardening): when a channel hook
 * reports `failed` (e.g. the SMTP relay rejected the message), the processor
 * THROWS so BullMQ retries with backoff — a transient outage must not
 * silently lose the email. The in-app copy is already persisted, so the
 * retry only re-attempts the channel; on retry the in-app persist is
 * deduped (see below) so the dashboard doesn't fill with duplicates.
 * `not_configured` does NOT throw: there is no provider to retry against
 * (dev mode), and the in-app record is the honest delivery.
 */

export type ChannelName = 'in-app' | 'email' | 'sms';

export interface ChannelResult {
  channel: ChannelName;
  /** delivered: hook confirmed send. queued: accepted for async send. not_configured: no provider wired. */
  status: 'delivered' | 'queued' | 'not_configured' | 'failed';
  detail?: string;
}

/**
 * Window in which a retried job reuses the in-app row persisted by its
 * earlier attempt instead of creating a duplicate. Covers the full retry
 * schedule (5 attempts, exponential backoff from 5s ≈ 13 min) with margin.
 */
const IN_APP_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

export type ChannelHook = (payload: NotificationJobPayload) => Promise<ChannelResult>;

const channelHooks = new Map<ChannelName, ChannelHook>();

/**
 * Wire a real provider, e.g.:
 *   registerChannelHook('email', sesHook); // SES / SendGrid / Postmark
 *   registerChannelHook('sms', twilioHook); // Twilio / Vonage
 * Call from the worker bootstrap once provider credentials exist.
 */
export function registerChannelHook(channel: ChannelName, hook: ChannelHook): void {
  channelHooks.set(channel, hook);
  log.info('notification.hook.registered', { channel });
}

export async function processNotification(job: Job<NotificationJobPayload>) {
  const { userId, channel, template, data, correlationId } = job.data;
  log.info('notification.dispatch.start', { jobId: job.id, userId, channel, template, correlationId });

  if (!userId || !template) {
    throw new Error('Notification job missing required fields: userId and template are required.');
  }

  // 1. Persist — the dashboard reads this; it is the only delivery we can
  //    guarantee ourselves. On a channel retry (attemptsMade > 0) the earlier
  //    attempt already persisted the row: reuse it instead of duplicating.
  const title = String(data?.title ?? template);
  const message = String(data?.message ?? '');
  const linkUrl = data?.linkUrl ? String(data.linkUrl) : undefined;

  let notification: { id: string };
  if (job.attemptsMade > 0) {
    const existing = await prisma.notification.findFirst({
      where: {
        recipientId: userId,
        title,
        message,
        createdAt: { gte: new Date(Date.now() - IN_APP_DEDUPE_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) {
      log.info('notification.dispatch.reused', {
        jobId: job.id,
        notificationId: existing.id,
        attemptsMade: job.attemptsMade,
        correlationId,
      });
      notification = existing;
    } else {
      notification = await prisma.notification.create({
        data: { recipientId: userId, title, message, linkUrl },
      });
    }
  } else {
    notification = await prisma.notification.create({
      data: { recipientId: userId, title, message, linkUrl },
    });
  }

  // 2. Dispatch to the requested channel.
  let result: ChannelResult;
  if (channel === 'in-app') {
    result = {
      channel,
      status: 'delivered',
      detail: `persisted as notification ${notification.id}`,
    };
  } else {
    const hook = channelHooks.get(channel);
    if (!hook) {
      result = {
        channel,
        status: 'not_configured',
        detail:
          `No ${channel} provider wired. In-app record ${notification.id} persisted; ` +
          `call registerChannelHook('${channel}', …) in the worker bootstrap to enable delivery.`,
      };
    } else {
      try {
        result = await hook(job.data);
      } catch (err: any) {
        result = { channel, status: 'failed', detail: err?.message || 'channel hook threw' };
      }
    }
  }

  log.info('notification.dispatch.done', {
    jobId: job.id,
    notificationId: notification.id,
    channel: result.channel,
    status: result.status,
    detail: result.detail,
    correlationId,
  });

  // Fail-LOUD (Phase 2 item 2): a confirmed channel failure throws so BullMQ
  // retries with backoff. The in-app row above is already persisted — it is
  // the guaranteed fallback, and the retry dedupes it (see step 1).
  // `not_configured` is NOT thrown: no provider exists to retry against.
  if (result.status === 'failed') {
    throw new Error(
      `Notification channel '${result.channel}' failed for notification ${notification.id}: ` +
        (result.detail || 'channel hook reported failure'),
    );
  }

  return { notificationId: notification.id, channel: result };
}
