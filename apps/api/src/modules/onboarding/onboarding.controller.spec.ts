/**
 * OnboardingController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { SystemRole } from '@ems/shared';

describe('OnboardingController', () => {
  let controller: OnboardingController;
  let service: any;

  const hrUser: any = {
    sub: 'hr-1',
    email: 'hr@ems.local',
    employeeId: 'emp-hr',
    roles: [SystemRole.HR_ADMIN],
  };
  const viewer = { userId: 'hr-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] };

  beforeEach(async () => {
    service = {
      createChecklist: jest.fn(),
      listChecklists: jest.fn(),
      getChecklist: jest.fn(),
      assignTask: jest.fn(),
      completeTask: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [{ provide: OnboardingService, useValue: service }],
    }).compile();

    controller = module.get<OnboardingController>(OnboardingController);
  });

  it('createChecklist forwards dto + viewer', () => {
    service.createChecklist.mockReturnValue({ id: 'cl1' });
    const dto: any = { employeeId: 'emp-9', kind: 'ONBOARDING' };
    controller.createChecklist(dto, hrUser);
    expect(service.createChecklist).toHaveBeenCalledWith(dto, viewer);
  });

  it('listChecklists requires an employee profile for non-HR', () => {
    const noProfile: any = { sub: 'u1', roles: [SystemRole.EMPLOYEE] };
    expect(() => controller.listChecklists(noProfile)).toThrow(ForbiddenException);
    expect(service.listChecklists).not.toHaveBeenCalled();
  });

  it('listChecklists lets HR through without an employee profile', () => {
    service.listChecklists.mockReturnValue([]);
    const hrNoProfile: any = { sub: 'hr-1', roles: [SystemRole.HR_ADMIN] };
    controller.listChecklists(hrNoProfile, 'emp-9');
    expect(service.listChecklists).toHaveBeenCalledWith(
      { userId: 'hr-1', employeeId: undefined, roles: [SystemRole.HR_ADMIN] },
      'emp-9',
    );
  });

  it('getChecklist forwards id + viewer', () => {
    service.getChecklist.mockReturnValue({ id: 'cl1' });
    controller.getChecklist('cl1', hrUser);
    expect(service.getChecklist).toHaveBeenCalledWith('cl1', viewer);
  });

  it('assignTask forwards id + dto + viewer', () => {
    service.assignTask.mockReturnValue({ id: 't1' });
    const dto: any = { assigneeId: 'emp-2' };
    controller.assignTask('t1', dto, hrUser);
    expect(service.assignTask).toHaveBeenCalledWith('t1', dto, viewer);
  });

  it('completeTask forwards id + dto + viewer', () => {
    service.completeTask.mockReturnValue({ id: 't1', status: 'DONE' });
    const dto: any = { note: 'done' };
    controller.completeTask('t1', dto, hrUser);
    expect(service.completeTask).toHaveBeenCalledWith('t1', dto, viewer);
  });
});
