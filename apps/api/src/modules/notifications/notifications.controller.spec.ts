/**
 * NotificationsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let service: any;

  const user: any = { sub: 'user-1', email: 'u@ems.local' };

  beforeEach(async () => {
    service = {
      getUserNotifications: jest.fn(),
      getUnreadCount: jest.fn(),
      markAllRead: jest.fn(),
      getVapidPublicKey: jest.fn(),
      savePushSubscription: jest.fn(),
      markAsRead: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  it('getMyNotifications forwards the user id and parsed query options', async () => {
    service.getUserNotifications.mockResolvedValue([]);
    await controller.getMyNotifications(user, 'true', 2, 10);
    expect(service.getUserNotifications).toHaveBeenCalledWith('user-1', {
      unreadOnly: true,
      page: 2,
      limit: 10,
    });
  });

  it('getMyNotifications treats unreadOnly=false correctly', async () => {
    service.getUserNotifications.mockResolvedValue([]);
    await controller.getMyNotifications(user, 'false', undefined, undefined);
    expect(service.getUserNotifications).toHaveBeenCalledWith('user-1', {
      unreadOnly: false,
      page: undefined,
      limit: undefined,
    });
  });

  it('getUnreadCount delegates to the service', async () => {
    service.getUnreadCount.mockResolvedValue({ count: 3 });
    await expect(controller.getUnreadCount(user)).resolves.toEqual({ count: 3 });
    expect(service.getUnreadCount).toHaveBeenCalledWith('user-1');
  });

  it('markAllRead delegates to the service', async () => {
    service.markAllRead.mockResolvedValue({ marked: 5 });
    await expect(controller.markAllRead(user)).resolves.toEqual({ marked: 5 });
    expect(service.markAllRead).toHaveBeenCalledWith('user-1');
  });

  it('getVapidPublicKey delegates to the service', async () => {
    service.getVapidPublicKey.mockResolvedValue({ key: 'vapid-key' });
    await expect(controller.getVapidPublicKey()).resolves.toEqual({ key: 'vapid-key' });
  });

  it('savePushSubscription forwards user id + dto', async () => {
    const dto: any = { endpoint: 'https://push', keys: { p256dh: 'p', auth: 'a' } };
    service.savePushSubscription.mockResolvedValue({ ok: true });
    await controller.savePushSubscription(dto, user);
    expect(service.savePushSubscription).toHaveBeenCalledWith('user-1', dto);
  });

  it('markAsRead forwards id + user id', async () => {
    service.markAsRead.mockResolvedValue({ ok: true });
    await controller.markAsRead('notif-1', user);
    expect(service.markAsRead).toHaveBeenCalledWith('notif-1', 'user-1');
  });
});
