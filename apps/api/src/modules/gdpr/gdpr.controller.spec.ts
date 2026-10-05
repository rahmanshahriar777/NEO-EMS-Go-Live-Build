/**
 * GdprController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

describe('GdprController', () => {
  let controller: GdprController;
  let service: any;

  const user: any = { sub: 'user-1', email: 'u@ems.local' };

  beforeEach(async () => {
    service = {
      createErasureRequest: jest.fn(),
      listErasureRequests: jest.fn(),
      reviewErasureRequest: jest.fn(),
      exportMyData: jest.fn(),
      getRetentionSchedule: jest.fn(),
      previewRetentionPurge: jest.fn(),
      purgeExpiredRetention: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GdprController],
      providers: [{ provide: GdprService, useValue: service }],
    }).compile();

    controller = module.get<GdprController>(GdprController);
  });

  it('createErasureRequest forwards user + dto', () => {
    service.createErasureRequest.mockReturnValue({ id: 'er-1' });
    const dto: any = { reason: 'leaving' };
    controller.createErasureRequest(dto, user);
    expect(service.createErasureRequest).toHaveBeenCalledWith(user, dto);
  });

  it('listErasureRequests forwards the query', () => {
    service.listErasureRequests.mockReturnValue([]);
    const query: any = { page: 1 };
    controller.listErasureRequests(query);
    expect(service.listErasureRequests).toHaveBeenCalledWith(query);
  });

  it('reviewErasureRequest forwards id + user + dto', () => {
    service.reviewErasureRequest.mockReturnValue({ id: 'er-1', status: 'APPROVED' });
    const dto: any = { decision: 'APPROVE' };
    controller.reviewErasureRequest('er-1', dto, user);
    expect(service.reviewErasureRequest).toHaveBeenCalledWith('er-1', user, dto);
  });

  it('exportMyData clamps pagination (page >= 1, limit 1..500)', () => {
    service.exportMyData.mockReturnValue({ user: {} });

    controller.exportMyData(user, '0', '9999');
    expect(service.exportMyData).toHaveBeenCalledWith(user, {
      attendancePage: 1,
      attendanceLimit: 500,
    });

    controller.exportMyData(user, undefined, undefined);
    expect(service.exportMyData).toHaveBeenCalledWith(user, {
      attendancePage: 1,
      attendanceLimit: 100,
    });

    controller.exportMyData(user, '3', '25');
    expect(service.exportMyData).toHaveBeenCalledWith(user, {
      attendancePage: 3,
      attendanceLimit: 25,
    });
  });

  it('retention endpoints delegate', () => {
    service.getRetentionSchedule.mockReturnValue({ entities: [] });
    service.previewRetentionPurge.mockReturnValue({ preview: [] });
    service.purgeExpiredRetention.mockReturnValue({ dryRun: true });

    controller.getRetentionSchedule();
    expect(service.getRetentionSchedule).toHaveBeenCalled();

    controller.previewRetentionPurge();
    expect(service.previewRetentionPurge).toHaveBeenCalled();

    controller.purgeRetention({ dryRun: false } as any);
    expect(service.purgeExpiredRetention).toHaveBeenCalledWith({ dryRun: false });
  });
});
