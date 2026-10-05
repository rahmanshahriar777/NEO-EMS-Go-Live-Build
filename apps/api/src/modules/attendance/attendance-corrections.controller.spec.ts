import { Test, TestingModule } from '@nestjs/testing';
import { AttendanceCorrectionsController } from './attendance-corrections.controller';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { ForbiddenException } from '@nestjs/common';

describe('AttendanceCorrectionsController', () => {
  let controller: AttendanceCorrectionsController;
  let service: any;

  const user = {
    sub: 'user-1',
    employeeId: 'emp-1',
    roles: ['EMPLOYEE'],
  } as any;

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      list: jest.fn().mockResolvedValue([]),
      decide: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AttendanceCorrectionsController],
      providers: [{ provide: AttendanceCorrectionsService, useValue: service }],
    }).compile();

    controller = module.get<AttendanceCorrectionsController>(AttendanceCorrectionsController);
  });

  it('POST delegates to service.create with the employee id and DTO', async () => {
    const dto = { attendanceRecordId: 'rec-1', requestedClockIn: '2026-10-05T09:05:00Z', reason: 'x' };
    await controller.create(dto as any, user);
    expect(service.create).toHaveBeenCalledWith('emp-1', dto);
  });

  it('POST rejects users without an employee record', async () => {
    await expect(
      controller.create({ attendanceRecordId: 'rec-1', reason: 'x' } as any, { ...user, employeeId: undefined }),
    ).rejects.toThrow(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('GET passes the status filter through to the service', async () => {
    await controller.list('PENDING', user);
    expect(service.list).toHaveBeenCalledWith(
      { userId: 'user-1', employeeId: 'emp-1', roles: ['EMPLOYEE'] },
      'PENDING',
    );
  });

  it('PATCH passes id, status and the decider context', async () => {
    await controller.decide('c1', { status: 'APPROVED' } as any, {
      ...user,
      employeeId: 'mgr-1',
      roles: ['MANAGER'],
    });
    expect(service.decide).toHaveBeenCalledWith(
      'c1',
      'APPROVED',
      { userId: 'user-1', employeeId: 'mgr-1', roles: ['MANAGER'] },
    );
  });
});
