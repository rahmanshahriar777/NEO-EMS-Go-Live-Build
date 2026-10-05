import { Test, TestingModule } from '@nestjs/testing';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { RedisService } from '../../core/redis/redis.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

describe('AttendanceCorrectionsService', () => {
  let service: AttendanceCorrectionsService;
  let prisma: any;
  let audit: any;
  let store: Map<string, string>;

  beforeEach(async () => {
    store = new Map();
    prisma = {
      attendanceRecord: {
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve(data)),
      },
      employee: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    audit = { log: jest.fn() };
    const redis = {
      get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: jest.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      del: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceCorrectionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get<AttendanceCorrectionsService>(AttendanceCorrectionsService);
  });

  const seedRecord = (overrides: any = {}) => {
    prisma.attendanceRecord.findUnique.mockResolvedValue({
      id: 'rec-1',
      employeeId: 'emp-1',
      clockInTime: new Date('2026-10-05T09:00:00Z'),
      clockOutTime: new Date('2026-10-05T17:00:00Z'),
      ...overrides,
    });
  };

  it('creates a PENDING correction for the record owner', async () => {
    seedRecord();

    const c = await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:05:00.000Z',
      reason: 'Forgot to clock in after the fire drill',
    });

    expect(c.status).toBe('PENDING');
    expect(c.employeeId).toBe('emp-1');
    expect(c.requestedClockIn).toBe('2026-10-05T09:05:00.000Z');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ATTENDANCE_CORRECTION' }),
    );
  });

  it('rejects corrections for another employee’s record', async () => {
    seedRecord();
    await expect(
      service.create('emp-2', {
        attendanceRecordId: 'rec-1',
        requestedClockIn: '2026-10-05T09:05:00Z',
        reason: 'x',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a second pending correction for the same record', async () => {
    seedRecord();
    await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:05:00Z',
      reason: 'x',
    });
    await expect(
      service.create('emp-1', {
        attendanceRecordId: 'rec-1',
        requestedClockOut: '2026-10-05T18:00:00Z',
        reason: 'y',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('requires at least one requested time and a reason', async () => {
    seedRecord();
    await expect(
      service.create('emp-1', { attendanceRecordId: 'rec-1', reason: 'x' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('emp-1', {
        attendanceRecordId: 'rec-1',
        requestedClockIn: '2026-10-05T09:05:00Z',
        reason: '  ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists with role scoping and status filter', async () => {
    seedRecord();
    await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:05:00Z',
      reason: 'x',
    });

    // owner sees own
    const own = await service.list({ userId: 'u1', employeeId: 'emp-1', roles: ['EMPLOYEE'] });
    expect(own).toHaveLength(1);
    // stranger sees none
    const none = await service.list({ userId: 'u2', employeeId: 'emp-9', roles: ['EMPLOYEE'] });
    expect(none).toHaveLength(0);
    // HR sees all
    const hr = await service.list({ userId: 'hr', roles: ['HR_ADMIN'] }, 'PENDING');
    expect(hr).toHaveLength(1);
    const approved = await service.list({ userId: 'hr', roles: ['HR_ADMIN'] }, 'APPROVED');
    expect(approved).toHaveLength(0);
  });

  it('manager approves: applies times and recomputes hours', async () => {
    seedRecord();
    prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', managerId: 'mgr-1' });

    const c = await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:30:00.000Z',
      reason: 'late start',
    });

    const decided = await service.decide(c.id, 'APPROVED', {
      userId: 'mgr-user',
      employeeId: 'mgr-1',
      roles: ['MANAGER'],
    });

    expect(decided.status).toBe('APPROVED');
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      data: expect.objectContaining({
        clockInTime: new Date('2026-10-05T09:30:00.000Z'),
        totalHoursWorked: 7.5, // 09:30 → 17:00
      }),
    });
  });

  it('blocks non-managers from deciding and self-decisions', async () => {
    seedRecord();
    prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', managerId: 'mgr-1' });
    const c = await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:05:00Z',
      reason: 'x',
    });

    await expect(
      service.decide(c.id, 'APPROVED', { userId: 'u9', employeeId: 'emp-9', roles: ['EMPLOYEE'] }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      service.decide(c.id, 'APPROVED', { userId: 'u1', employeeId: 'emp-1', roles: ['EMPLOYEE'] }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects deciding an already-decided correction', async () => {
    seedRecord();
    prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', managerId: 'mgr-1' });
    const c = await service.create('emp-1', {
      attendanceRecordId: 'rec-1',
      requestedClockIn: '2026-10-05T09:05:00Z',
      reason: 'x',
    });
    await service.decide(c.id, 'REJECTED', { userId: 'hr', roles: ['HR_ADMIN'] });
    await expect(
      service.decide(c.id, 'APPROVED', { userId: 'hr', roles: ['HR_ADMIN'] }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for unknown ids', async () => {
    await expect(
      service.decide('nope', 'APPROVED', { userId: 'hr', roles: ['HR_ADMIN'] }),
    ).rejects.toThrow(NotFoundException);
  });
});
