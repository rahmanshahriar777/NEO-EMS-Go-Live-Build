import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QueueService } from '../../core/queues/queue.service';

/**
 * Notification centre backend (Phase 2 item 2).
 *
 * Delivery model:
 *  - The in-app `notifications` row is ALWAYS persisted first — it is the
 *    source of truth the bell dropdown reads.
 *  - An email copy is OPTIONAL per event: `notify({ emailCopy: true, ... })`
 *    enqueues onto the LIVE `notifications` queue (channel 'email'). The
 *    worker persists the in-app row first, then delivers via its registered
 *    email channel hook (fail-loud: hook failures throw so BullMQ retries
 *    with backoff, then the job lands in the DLQ).
 *
 *    The old standalone `email` queue producer was DELETED (go-live HIGH
 *    #2): it had no consumer, so every email copy enqueued onto it was
 *    silently lost. There is exactly one email path now — the
 *    `notifications` channel-'email' path.
 *  - If the email enqueue itself fails (Redis down), notify() falls back to
 *    persisting the in-app row directly — the guaranteed fallback — and
 *    never throws (event emitters keep their fail-open contract).
 *
 * Event emitters (leave, payroll, reviews, documents) call `notify()` with a
 * stable `idempotencyKey` (e.g. `leave-approved:<requestId>`) so retried
 * business operations never double-notify.
 */
export interface NotifyInput {
  /** Recipient USER id (Notification.recipientId is a User FK). */
  userId: string;
  /** Stable event key, e.g. 'leave-request-created'. Used as the title fallback. */
  template: string;
  title: string;
  message: string;
  linkUrl?: string;
  /** Stable idempotency key for the email copy, e.g. `leave-approved:<id>`. */
  idempotencyKey?: string;
  /** When true (and `emailTo` is set), enqueue an email copy. */
  emailCopy?: boolean;
  emailTo?: string;
  emailSubject?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}


@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
  ) {}

  async getUserNotifications(userId: string, opts?: { unreadOnly?: boolean; page?: number; limit?: number }) {
    const page = Math.max(1, opts?.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
    const where: any = {
      recipientId: userId,
      ...(opts?.unreadOnly ? { isRead: false } : {}),
    };
    const [items, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { recipientId: userId, isRead: false } }),
    ]);
    return {
      items,
      unreadCount,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getUnreadCount(userId: string): Promise<{ unreadCount: number }> {
    const unreadCount = await this.prisma.notification.count({
      where: { recipientId: userId, isRead: false },
    });
    return { unreadCount };
  }

  async markAsRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, recipientId: userId },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { recipientId: userId, isRead: false },
      data: { isRead: true },
    });
    return { markedRead: result.count };
  }

  async createNotification(recipientId: string, title: string, message: string, linkUrl?: string) {
    return this.prisma.notification.create({
      data: {
        recipientId,
        title,
        message,
        linkUrl,
      },
    });
  }

  /**
   * Central event emitter. Email copies go through the live `notifications`
   * queue (channel 'email'); the worker persists the in-app row first, then
   * delivers via the email channel hook. Never throws: if the enqueue
   * itself fails, the in-app row is persisted here as the guaranteed
   * fallback.
   *
   * Returns `notificationId: null` when the email was queued — the worker
   * creates the in-app row in that path.
   */
  async notify(input: NotifyInput): Promise<{ notificationId: string | null; emailQueued: boolean }> {
    if (input.emailCopy) {
      if (!input.emailTo) {
        this.logger.warn(
          `notify: emailCopy requested for template '${input.template}' but no emailTo; skipping email`,
        );
      } else {
        try {
          // correlationId intentionally omitted: the queue service resolves
          // the ambient request correlation (x-request-id via ALS) instead
          // of minting a fresh UUID (go-live Phase 3 item 10).
          const jobId = await this.queueService.enqueueNotification(
            input.userId,
            'email',
            input.template,
            {
              // Recipient override: the worker's email hook prefers
              // `data.email`, falling back to the user's account email.
              email: input.emailTo,
              subject: input.emailSubject ?? input.title,
              title: input.title,
              message: input.message,
              linkUrl: input.linkUrl,
            },
            undefined,
            input.idempotencyKey ?? `notify-email:${input.userId}:${Date.now()}:${randomUUID()}`,
          );
          return { notificationId: null, emailQueued: jobId != null };
        } catch (err) {
          // Fail-safe: the email job was NOT scheduled (e.g. Redis down).
          // Fall through and persist the in-app row below — it is the
          // guaranteed fallback, so event emitters keep their never-throws
          // contract while the email is simply not sent this time.
          this.logger.error(
            `notify: email enqueue failed for user ${input.userId} (in-app fallback will be persisted)`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }
    }

    const notification = await this.prisma.notification.create({
      data: {
        recipientId: input.userId,
        title: input.title,
        message: input.message,
        linkUrl: input.linkUrl,
      },
    });

    return { notificationId: notification.id, emailQueued: false };
  }

  // ---------------------------------------------------------------------------
  // Web push (Phase 3 item 7 — PWA). Subscriptions are persisted in the
  // PushSubscription table (one row per user+endpoint).
  // ---------------------------------------------------------------------------

  /**
   * The VAPID public key is published (not a secret). Returns null when
   * unconfigured — the web client falls back to NEXT_PUBLIC_VAPID_PUBLIC_KEY.
   */
  async getVapidPublicKey(): Promise<{ vapidPublicKey: string | null }> {
    return { vapidPublicKey: this.configService.get<string>('VAPID_PUBLIC_KEY') || null };
  }

  async savePushSubscription(userId: string, input: PushSubscriptionInput) {
    if (!input?.endpoint || typeof input.endpoint !== 'string') {
      throw new BadRequestException('Push subscription endpoint is required');
    }
    if (!input.keys?.p256dh || !input.keys?.auth) {
      throw new BadRequestException('Push subscription keys (p256dh, auth) are required');
    }
    await (this.prisma as any).pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint: input.endpoint } },
      update: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
      },
    });
    this.logger.log(`Push subscription saved for user ${userId}`);
    return { saved: true };
  }

  async getPushSubscription(userId: string) {
    const sub = await (this.prisma as any).pushSubscription.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) return null;
    return {
      userId: sub.userId,
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      expirationTime: null,
    };
  }

  async deletePushSubscription(userId: string) {
    await (this.prisma as any).pushSubscription.deleteMany({ where: { userId } });
    return { deleted: true };
  }
}
