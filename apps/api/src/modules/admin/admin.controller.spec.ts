/**
 * AdminController wiring tests (Phase 2 item 8: admin unlock + session kill).
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminController', () => {
  let controller: AdminController;
  let adminService: any;

  const caller: any = { sub: 'admin-1', email: 'admin@ems.local' };

  beforeEach(async () => {
    adminService = { unlockUser: jest.fn(), killSessions: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: adminService }],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  it('unlock forwards the target id + caller identity', async () => {
    adminService.unlockUser.mockResolvedValue({ id: 'user-9', unlocked: true });

    const res = await controller.unlock('user-9', caller);

    expect(adminService.unlockUser).toHaveBeenCalledWith('user-9', {
      userId: 'admin-1',
      email: 'admin@ems.local',
    });
    expect(res).toEqual({ success: true, data: { id: 'user-9', unlocked: true } });
  });

  it('killSessions forwards the target id + caller identity', async () => {
    adminService.killSessions.mockResolvedValue({ id: 'user-9', sessionsRevoked: true });

    const res = await controller.killSessions('user-9', caller);

    expect(adminService.killSessions).toHaveBeenCalledWith('user-9', {
      userId: 'admin-1',
      email: 'admin@ems.local',
    });
    expect(res).toEqual({ success: true, data: { id: 'user-9', sessionsRevoked: true } });
  });
});
