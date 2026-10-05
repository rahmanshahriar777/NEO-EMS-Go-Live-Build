import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { QueueService } from '../../core/queues/queue.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: any;
  let queueService: any;
  let redis: any;

  beforeEach(async () => {
    prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ id: 'notif-1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    queueService = { enqueueNotification: jest.fn().mockResolvedValue('job-1') };
    redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: QueueService, useValue: queueService },
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('returns unread count', async () => {
    prisma.notification.count.mockResolvedValue(7);
    await expect(service.getUnreadCount('user-1')).resolves.toEqual({ unreadCount: 7 });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { recipientId: 'user-1', isRead: false },
    });
  });

  it('lists with pagination and includes unread count', async () => {
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);
    prisma.notification.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);

    const res = await service.getUserNotifications('user-1', {
      unreadOnly: true,
      page: 1,
      limit: 20,
    });

    expect(res.items).toHaveLength(1);
    expect(res.unreadCount).toBe(3);
    expect(res.meta.total).toBe(1);
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { recipientId: 'user-1', isRead: false } }),
    );
  });

  it('markAllRead marks only unread notifications', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 4 });

    await expect(service.markAllRead('user-1')).resolves.toEqual({ markedRead: 4 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: 'user-1', isRead: false },
      data: { isRead: true },
    });
  });

  it('notify with emailCopy enqueues onto the live notifications queue (channel email)', async () => {
    const res = await service.notify({
      userId: 'user-1',
      template: 'leave-request-approved',
      title: 'Leave request approved',
      message: 'Your leave was approved.',
      idempotencyKey: 'leave-decision:req-1',
      emailCopy: true,
      emailTo: 'ada@example.com',
    });

    // The worker creates the in-app row in this path (persist-first, then
    // the email channel hook), so the API does not persist one itself and
    // there is exactly one in-app copy — no duplicates.
    expect(res.notificationId).toBeNull();
    expect(res.emailQueued).toBe(true);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(queueService.enqueueNotification).toHaveBeenCalledWith(
      'user-1',
      'email',
      'leave-request-approved',
      expect.objectContaining({
        email: 'ada@example.com',
        subject: 'Leave request approved',
        title: 'Leave request approved',
        message: 'Your leave was approved.',
      }),
      undefined,
      'leave-decision:req-1',
    );
  });

  it('notify without emailCopy persists in-app only and touches no queue', async () => {
    const res = await service.notify({
      userId: 'user-1',
      template: 'leave-request-created',
      title: 'New leave request',
      message: 'Someone requested leave.',
    });

    expect(res.notificationId).toBe('notif-1');
    expect(res.emailQueued).toBe(false);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientId: 'user-1', title: 'New leave request' }),
    });
    expect(queueService.enqueueNotification).not.toHaveBeenCalled();
  });

  it('notify warns and skips the email when emailCopy is set without emailTo', async () => {
    const res = await service.notify({
      userId: 'user-1',
      template: 'review-completed',
      title: 'Review completed',
      message: 'Done.',
      emailCopy: true,
    });

    expect(res.notificationId).toBe('notif-1');
    expect(res.emailQueued).toBe(false);
    expect(queueService.enqueueNotification).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  it('notify never throws when the enqueue throws (fail-safe; in-app copy persisted)', async () => {
    queueService.enqueueNotification.mockRejectedValue(new Error('Redis unavailable'));

    const res = await service.notify({
      userId: 'user-1',
      template: 'review-completed',
      title: 'Review completed',
      message: 'Done.',
      emailCopy: true,
      emailTo: 'ada@example.com',
    });

    // In-app row is the guaranteed fallback: no throw, emailQueued false.
    expect(res.notificationId).toBe('notif-1');
    expect(res.emailQueued).toBe(false);
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientId: 'user-1', title: 'Review completed' }),
    });
  });

  describe('web push', () => {
    it('returns null vapid key when unconfigured', async () => {
      await expect(service.getVapidPublicKey()).resolves.toEqual({ vapidPublicKey: null });
    });

    it('saves and reads a push subscription', async () => {
      const sub = {
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'p256', auth: 'auth' },
      };
      prisma.pushSubscription = {
        upsert: jest.fn().mockResolvedValue({ id: 'ps-1' }),
        findFirst: jest.fn().mockResolvedValue({
          userId: 'user-1',
          endpoint: 'https://push.example/abc',
          p256dh: 'p256',
          auth: 'auth',
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      };

      await expect(service.savePushSubscription('user-1', sub)).resolves.toEqual({ saved: true });
      expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith({
        where: { userId_endpoint: { userId: 'user-1', endpoint: 'https://push.example/abc' } },
        update: { p256dh: 'p256', auth: 'auth' },
        create: {
          userId: 'user-1',
          endpoint: 'https://push.example/abc',
          p256dh: 'p256',
          auth: 'auth',
        },
      });

      const read = await service.getPushSubscription('user-1');
      expect(read.endpoint).toBe('https://push.example/abc');
      expect(read.keys).toEqual({ p256dh: 'p256', auth: 'auth' });

      await expect(service.deletePushSubscription('user-1')).resolves.toEqual({ deleted: true });
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });

    it('rejects subscriptions without endpoint or keys', async () => {
      prisma.pushSubscription = { upsert: jest.fn() };
      await expect(
        service.savePushSubscription('user-1', { endpoint: '', keys: { p256dh: 'x', auth: 'y' } }),
      ).rejects.toThrow();
      await expect(
        service.savePushSubscription('user-1', {
          endpoint: 'https://x',
          keys: { p256dh: '', auth: '' },
        } as any),
      ).rejects.toThrow();
      expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
    });
  });
});
