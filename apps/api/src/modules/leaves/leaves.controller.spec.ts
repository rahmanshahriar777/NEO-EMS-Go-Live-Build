/**
 * LeavesController wiring tests — delegation + viewer scoping.
 * (Guard behavior is covered by common/guards/access-matrix.spec.ts.)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';
import { SystemRole, JwtPayload, LeaveStatus } from '@ems/shared';

const user = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'user@ems.local',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

describe('LeavesController', () => {
  let controller: LeavesController;
  let service: any;

  beforeEach(async () => {
    service = {
      getLeaveTypes: jest.fn(),
      createLeaveType: jest.fn(),
      getEmployeeBalances: jest.fn(),
      reconcileBalance: jest.fn(),
      createLeaveRequest: jest.fn(),
      getLeaveRequests: jest.fn(),
      getLeaveRequestById: jest.fn(),
      approveOrReject: jest.fn(),
      cancelLeave: jest.fn(),
      getHolidays: jest.fn(),
      createHoliday: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LeavesController],
      providers: [{ provide: LeavesService, useValue: service }],
    }).compile();

    controller = module.get<LeavesController>(LeavesController);
  });

  it('createLeaveRequest requires a linked employee profile', () => {
    expect(() =>
      controller.createLeaveRequest({} as any, user({ employeeId: undefined })),
    ).toThrow(ForbiddenException);
    expect(service.createLeaveRequest).not.toHaveBeenCalled();
  });

  it('createLeaveRequest delegates with the caller employee id', async () => {
    service.createLeaveRequest.mockResolvedValue({ id: 'req-1' });
    const dto = { leaveTypeId: 'lt-1' };

    const result = await controller.createLeaveRequest(dto as any, user());

    expect(service.createLeaveRequest).toHaveBeenCalledWith('emp-1', dto);
    expect(result).toEqual({ id: 'req-1' });
  });

  it('approveLeave forces APPROVED and passes the approver employee id', async () => {
    service.approveOrReject.mockResolvedValue({ id: 'req-1', status: LeaveStatus.APPROVED });

    await controller.approveLeave('req-1', { remarks: 'ok' } as any, user({ roles: [SystemRole.MANAGER], employeeId: 'mgr-1' }));

    expect(service.approveOrReject).toHaveBeenCalledWith(
      'req-1',
      'mgr-1',
      { status: LeaveStatus.APPROVED, remarks: 'ok' },
      'user@ems.local',
      'user-1',
      [SystemRole.MANAGER],
    );
  });

  it('rejectLeave forces REJECTED', async () => {
    service.approveOrReject.mockResolvedValue({ id: 'req-1', status: LeaveStatus.REJECTED });

    await controller.rejectLeave('req-1', {} as any, user({ roles: [SystemRole.HR_ADMIN], employeeId: 'hr-1' }));

    expect(service.approveOrReject).toHaveBeenCalledWith(
      'req-1',
      'hr-1',
      { status: LeaveStatus.REJECTED, remarks: undefined },
      'user@ems.local',
      'user-1',
      [SystemRole.HR_ADMIN],
    );
  });

  it('getLeaveBalances: non-HR callers always read their own balance', async () => {
    service.getEmployeeBalances.mockResolvedValue([]);

    // An employee attempting to read someone else's balance is coerced to self.
    await controller.getLeaveBalances(user(), 'emp-999', undefined);
    expect(service.getEmployeeBalances).toHaveBeenCalledWith('emp-1', expect.any(Number));

    // HR may target another employee.
    await controller.getLeaveBalances(
      user({ roles: [SystemRole.HR_ADMIN], employeeId: 'hr-1' }),
      'emp-999',
      '2026',
    );
    expect(service.getEmployeeBalances).toHaveBeenCalledWith('emp-999', 2026);
  });

  it('getLeaveRequests builds the viewer from the JWT and clamps the limit', async () => {
    service.getLeaveRequests.mockResolvedValue({ data: { items: [] } });

    await controller.getLeaveRequests(user(), undefined, undefined, 1, 500);

    expect(service.getLeaveRequests).toHaveBeenCalledWith(
      { userId: 'user-1', employeeId: 'emp-1', roles: [SystemRole.EMPLOYEE] },
      expect.objectContaining({ page: 1, limit: 100 }),
    );
  });

  it('cancelLeave delegates with the caller employee id', async () => {
    service.cancelLeave.mockResolvedValue({ id: 'req-1', status: LeaveStatus.CANCELLED });

    await controller.cancelLeave('req-1', user());

    expect(service.cancelLeave).toHaveBeenCalledWith('req-1', 'emp-1', {
      userId: 'user-1',
      roles: [SystemRole.EMPLOYEE],
    });
  });
});
