/**
 * AttendanceController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { SystemRole } from '@ems/shared';

describe('AttendanceController', () => {
  let controller: AttendanceController;
  let service: any;

  const employeeUser: any = {
    sub: 'user-1',
    email: 'u@ems.local',
    employeeId: 'emp-1',
    roles: [SystemRole.EMPLOYEE],
  };
  const superAdminUser: any = {
    sub: 'admin-1',
    email: 'a@ems.local',
    employeeId: 'emp-admin',
    roles: [SystemRole.SUPER_ADMIN],
  };

  beforeEach(async () => {
    service = {
      clockIn: jest.fn(),
      clockOut: jest.fn(),
      getMyAttendance: jest.fn(),
      getTeamAttendance: jest.fn(),
      getReports: jest.fn(),
      reviewCorrection: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttendanceController],
      providers: [{ provide: AttendanceService, useValue: service }],
    }).compile();

    controller = module.get<AttendanceController>(AttendanceController);
  });

  it('clockIn uses the linked employee for non-admins', async () => {
    service.clockIn.mockResolvedValue({ id: 'rec-1' });
    const dto: any = { employeeId: 'emp-other' };

    const res = await controller.clockIn(dto, employeeUser);

    expect(service.clockIn).toHaveBeenCalledWith('emp-1', dto);
    expect(res).toEqual({ success: true, message: 'Clocked in successfully', data: { id: 'rec-1' } });
  });

  it('clockIn lets SUPER_ADMIN clock in for another employee', async () => {
    service.clockIn.mockResolvedValue({ id: 'rec-2' });
    await controller.clockIn({ employeeId: 'emp-other' } as any, superAdminUser);
    expect(service.clockIn).toHaveBeenCalledWith('emp-other', { employeeId: 'emp-other' });
  });

  it('clockIn throws when no employee is linked', async () => {
    await expect(
      controller.clockIn({} as any, { ...employeeUser, employeeId: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.clockIn).not.toHaveBeenCalled();
  });

  it('clockOut uses the linked employee and wraps the result', async () => {
    service.clockOut.mockResolvedValue({ id: 'rec-1' });
    const dto: any = {};
    const res = await controller.clockOut(dto, employeeUser);
    expect(service.clockOut).toHaveBeenCalledWith('emp-1', dto);
    expect(res.success).toBe(true);
  });

  it('getMyAttendance requires a linked employee', async () => {
    await expect(
      controller.getMyAttendance({ ...employeeUser, employeeId: undefined }, {} as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getMyAttendance delegates with the employee id + query', async () => {
    service.getMyAttendance.mockResolvedValue([]);
    const query: any = { from: '2026-09-01' };
    await controller.getMyAttendance(employeeUser, query);
    expect(service.getMyAttendance).toHaveBeenCalledWith('emp-1', query);
  });

  it('getTeamAttendance delegates with the manager employee id + query', async () => {
    service.getTeamAttendance.mockResolvedValue([]);
    const query: any = {};
    await controller.getTeamAttendance(employeeUser, query);
    expect(service.getTeamAttendance).toHaveBeenCalledWith('emp-1', query);
  });

  it('getReports delegates the query', async () => {
    service.getReports.mockResolvedValue({ rows: [] });
    const query: any = { from: '2026-01-01', to: '2026-12-31' };
    await controller.getReports(query);
    expect(service.getReports).toHaveBeenCalledWith(query);
  });
});
