import { Test, TestingModule } from '@nestjs/testing';
import { LeavesService, LeaveViewer } from './leaves.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { LeaveStatus, AuditAction, SystemRole } from '@ems/shared';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Leaves module tests — the module previously had zero specs.
 * All dates below are real calendar fixtures (verified weekdays):
 * - 2026-10-12..14 = Mon..Wed, 2026-10-10..11 = Sat..Sun
 * - 2026-11-02..03 = Mon..Tue
 * - 2026-12-30 (Wed)..2027-01-05 (Tue) spans the year boundary
 */
describe('LeavesService', () => {
  let service: LeavesService;
  let prisma: any;
  let tx: any;
  let audit: any;

  const viewer = (overrides: Partial<LeaveViewer> = {}): LeaveViewer => ({
    userId: 'user-1',
    employeeId: 'emp-1',
    roles: [SystemRole.EMPLOYEE],
    ...overrides,
  });

  const pendingRequest = (overrides: Record<string, any> = {}) => ({
    id: 'req-1',
    employeeId: 'emp-1',
    leaveTypeId: 'lt-1',
    startDate: new Date('2026-10-12T00:00:00Z'),
    endDate: new Date('2026-10-13T00:00:00Z'), // Mon-Tue: 2 working days
    status: LeaveStatus.PENDING,
    employee: { id: 'emp-1', managerId: 'mgr-1' },
    ...overrides,
  });

  beforeEach(async () => {
    // information_schema probe (schema-compat shim): pretend the Phase 2/3
    // columns exist so writes include them.
    const infoSchemaColumns: Record<string, string[]> = {
      leave_requests: ['id', 'halfDay', 'halfDayPeriod', 'approvalChain', 'currentStep'],
      leave_approvals: ['id', 'approverUserId'],
      employees: ['id'],
    };
    const queryRawMock = jest.fn((strings: TemplateStringsArray, table: string) =>
      Promise.resolve(
        (infoSchemaColumns[table] || ['id']).map((column_name) => ({ column_name })),
      ),
    );
    prisma = {
      $queryRaw: queryRawMock,
      leaveType: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
      leavePolicy: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
      leaveBalance: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      leaveRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      leaveApproval: { create: jest.fn() },
      holiday: { findMany: jest.fn(), upsert: jest.fn() },
      employee: { findMany: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    tx = {
      leaveRequest: prisma.leaveRequest,
      leaveBalance: prisma.leaveBalance,
      leaveType: prisma.leaveType,
      leavePolicy: prisma.leavePolicy,
      holiday: prisma.holiday,
      leaveApproval: prisma.leaveApproval,
      employee: prisma.employee,
      $queryRaw: prisma.$queryRaw,
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    audit = { log: jest.fn() };
    const notifications = { createNotification: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeavesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<LeavesService>(LeavesService);
  });

  describe('createLeaveRequest', () => {
    const dto = {
      leaveTypeId: 'lt-1',
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      reason: 'Family vacation',
    };

    it('rejects a range where the end precedes the start', async () => {
      await expect(
        service.createLeaveRequest('emp-1', { ...dto, startDate: '2026-10-14', endDate: '2026-10-12' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('detects overlap against PENDING/APPROVED ranges (409)', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue({
        id: 'req-old',
        startDate: new Date('2026-10-12T00:00:00Z'),
        endDate: new Date('2026-10-13T00:00:00Z'),
        status: LeaveStatus.PENDING,
      });

      await expect(service.createLeaveRequest('emp-1', dto)).rejects.toThrow(ConflictException);
      expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('rejects a weekend-only range (no working days)', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);

      await expect(
        service.createLeaveRequest('emp-1', {
          ...dto,
          startDate: '2026-10-10', // Saturday
          endDate: '2026-10-11', // Sunday
        }),
      ).rejects.toThrow(/no working days/i);
    });

    it('creates a request, charging working days against the balance', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026', remainingDays: 20 });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const req = await service.createLeaveRequest('emp-1', dto);

      expect(req.totalDays).toBe(3); // Mon-Wed
      expect(req.status).toBe(LeaveStatus.PENDING);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { pendingDays: { increment: 3 }, remainingDays: { decrement: 3 } },
      });
      expect(prisma.leaveRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ totalDays: 3 }) }),
      );
    });

    it('excludes holidays from the working-day count', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([{ date: new Date('2026-10-13T00:00:00Z') }]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026', remainingDays: 20 });
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const req = await service.createLeaveRequest('emp-1', dto);

      expect(req.totalDays).toBe(2); // Tue is a holiday
    });

    it('splits cross-year requests across each year\'s balance', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockImplementation(({ where }: any) => ({
        id: `bal-${where.employeeId_leaveTypeId_year.year}`,
        remainingDays: 20,
      }));
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const req = await service.createLeaveRequest('emp-1', {
        ...dto,
        startDate: '2026-12-30', // Wed
        endDate: '2027-01-05', // Tue
      });

      // 2026: Dec 30-31 = 2 days; 2027: Jan 1, 4, 5 = 3 days
      expect(req.totalDays).toBe(5);
      const increments = prisma.leaveBalance.update.mock.calls.map((c: any) => c[0].data.pendingDays.increment);
      expect(increments.sort()).toEqual([2, 3]);
      const balanceIds = prisma.leaveBalance.update.mock.calls.map((c: any) => c[0].where.id);
      expect(balanceIds.sort()).toEqual(['bal-2026', 'bal-2027']);
    });

    it('rejects when a year\'s balance cannot cover its segment', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026', remainingDays: 1 });

      await expect(service.createLeaveRequest('emp-1', dto)).rejects.toThrow(
        /insufficient leave balance for 2026/i,
      );
      expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('lazily creates a missing balance from the leave type defaults', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveType.findUnique.mockResolvedValue({ id: 'lt-1', defaultDaysPerYear: 25 });
      prisma.leaveBalance.findUnique.mockResolvedValue(null);
      prisma.leaveBalance.create.mockResolvedValue({ id: 'bal-new', remainingDays: 25 });
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      await service.createLeaveRequest('emp-1', dto);

      expect(prisma.leaveBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ allocatedDays: 25, remainingDays: 25, year: 2026 }),
      });
    });

    it('fails when the leave type does not exist', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue(null);
      prisma.leaveType.findUnique.mockResolvedValue(null);

      await expect(service.createLeaveRequest('emp-1', dto)).rejects.toThrow(NotFoundException);
    });

    it('creates a half-day request consuming 0.5 days', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leavePolicy.findUnique.mockResolvedValue(null);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026', remainingDays: 20 });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));
      prisma.employee.findUnique.mockResolvedValue({ managerId: 'mgr-1' });
      prisma.leaveRequest.findMany.mockResolvedValue([]);

      const req: any = await service.createLeaveRequest('emp-1', {
        ...dto,
        startDate: '2026-10-12', // Monday
        endDate: '2026-10-12',
        halfDay: true,
        halfDayPeriod: 'AM',
      });

      expect(req.totalDays).toBe(0.5);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { pendingDays: { increment: 0.5 }, remainingDays: { decrement: 0.5 } },
      });
    });

    it('rejects a half-day spanning multiple days', async () => {
      await expect(
        service.createLeaveRequest('emp-1', { ...dto, halfDay: true }),
      ).rejects.toThrow(/single day/i);
    });

    it('warns about teammates on overlapping approved leave (non-blocking)', async () => {
      prisma.leaveRequest.findFirst.mockResolvedValue(null);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leavePolicy.findUnique.mockResolvedValue(null);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026', remainingDays: 20 });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));
      prisma.employee.findUnique.mockResolvedValue({ managerId: 'mgr-1' });
      prisma.leaveRequest.findMany.mockResolvedValue([
        {
          employeeId: 'emp-2',
          startDate: new Date('2026-10-12T00:00:00Z'),
          endDate: new Date('2026-10-13T00:00:00Z'),
          employee: { firstName: 'Bob', lastName: 'Jones' },
        },
      ]);

      const req: any = await service.createLeaveRequest('emp-1', dto);

      expect(req.totalDays).toBe(3); // request still created
      expect(req.warnings).toEqual([
        {
          employeeId: 'emp-2',
          name: 'Bob Jones',
          startDate: '2026-10-12',
          endDate: '2026-10-13',
        },
      ]);
    });
  });

  describe('applyAnnualCarryOver', () => {
    it('carries unused days capped by policy (default 5)', async () => {
      prisma.leaveBalance.findMany.mockResolvedValue([
        { id: 'b1', employeeId: 'emp-1', leaveTypeId: 'lt-1', remainingDays: 8 },
        { id: 'b2', employeeId: 'emp-2', leaveTypeId: 'lt-1', remainingDays: 0 },
      ]);
      prisma.leavePolicy.findUnique.mockResolvedValue(null); // no policy -> cap 5
      prisma.leaveBalance.findUnique.mockResolvedValue(null);
      prisma.leaveType.findUnique.mockResolvedValue({ id: 'lt-1', defaultDaysPerYear: 14 });
      prisma.leaveBalance.create.mockImplementation(({ data }: any) => ({ id: 'new', ...data }));
      prisma.leaveBalance.update.mockResolvedValue({});

      const result: any = await service.applyAnnualCarryOver(2026, 2027, 'user-hr', 'hr@ems.local');

      expect(result.applied).toBe(1);
      expect(result.results[0]).toEqual({
        employeeId: 'emp-1',
        leaveTypeId: 'lt-1',
        carriedDays: 5,
        cap: 5,
      });
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'new' },
        data: {
          allocatedDays: { increment: 5 },
          remainingDays: { increment: 5 },
        },
      });
    });
  });

  describe('approveOrReject', () => {
    const approveDto = { status: LeaveStatus.APPROVED as const, remarks: 'Enjoy!' };

    it('throws NotFoundException for an unknown request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(null);

      await expect(service.approveOrReject('nope', 'mgr-1', approveDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects action on a non-PENDING request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest({ status: LeaveStatus.APPROVED }));

      await expect(service.approveOrReject('req-1', 'mgr-1', approveDto)).rejects.toThrow(
        /already been APPROVED/i,
      );
    });

    it('blocks self-approval (403)', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(service.approveOrReject('req-1', 'emp-1', approveDto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    });

    it('approves: moves pending -> used and records the approval', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());
      prisma.employee.findUnique.mockResolvedValue({ userId: 'user-mgr-1' });
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026' });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));
      prisma.leaveApproval.create.mockResolvedValue({ id: 'appr-1' });

      const updated = await service.approveOrReject('req-1', 'mgr-1', approveDto, 'mgr@ems.local');

      expect(updated.status).toBe(LeaveStatus.APPROVED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { pendingDays: { decrement: 2 }, usedDays: { increment: 2 } },
      });
      expect(prisma.leaveApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          leaveRequestId: 'req-1',
          approverId: 'mgr-1',
          status: LeaveStatus.APPROVED,
          remarks: 'Enjoy!',
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.APPROVE,
          entityType: 'LEAVE_REQUEST',
          actorId: 'user-mgr-1',
        }),
        expect.anything(),
      );
      // B4: the approver's USER id (not employee id) lands in the audit trail.
      expect(prisma.leaveApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          approverId: 'mgr-1',
          approverUserId: 'user-mgr-1',
        }),
      });
    });

    it('A2: rejects approval by someone who is neither the manager nor HR (403)', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(
        service.approveOrReject('req-1', 'emp-9', approveDto, 'x@ems.local', 'user-x', [
          SystemRole.MANAGER,
        ]),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
    });

    it('A2: allows HR (non-manager) to approve', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026' });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const updated = await service.approveOrReject('req-1', 'hr-1', approveDto, 'hr@ems.local', 'user-hr', [
        SystemRole.HR_ADMIN,
      ]);

      expect(updated.status).toBe(LeaveStatus.APPROVED);
    });

    it('rejects: releases pending days back to remaining', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026' });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      await service.approveOrReject('req-1', 'mgr-1', { status: LeaveStatus.REJECTED });

      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { pendingDays: { decrement: 2 }, remainingDays: { increment: 2 } },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REJECT }),
        expect.anything(),
      );
    });

    it('skips balance segments gracefully when the balance row is missing', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue(null);
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const updated = await service.approveOrReject('req-1', 'mgr-1', approveDto);

      expect(updated.status).toBe(LeaveStatus.APPROVED);
      expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelLeave', () => {
    it('throws NotFoundException for an unknown request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(null);

      await expect(service.cancelLeave('nope', 'emp-1')).rejects.toThrow(NotFoundException);
    });

    it('forbids cancelling another employee\'s request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());

      await expect(service.cancelLeave('req-1', 'emp-2')).rejects.toThrow(ForbiddenException);
    });

    it('allows the owner to cancel APPROVED leave and restores used days', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        pendingRequest({ status: LeaveStatus.APPROVED }),
      );
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026' });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const updated = await service.cancelLeave('req-1', 'emp-1');

      expect(updated.status).toBe(LeaveStatus.CANCELLED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { usedDays: { decrement: 2 }, remainingDays: { increment: 2 } },
      });
    });

    it('rejects cancelling APPROVED leave by an unrelated employee', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        pendingRequest({ status: LeaveStatus.APPROVED }),
      );

      await expect(
        service.cancelLeave('req-1', 'emp-9', { userId: 'user-9', roles: ['EMPLOYEE'] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('cancels and releases the reserved days', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(pendingRequest());
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.findUnique.mockResolvedValue({ id: 'bal-2026' });
      prisma.leaveBalance.update.mockResolvedValue({});
      prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));

      const updated = await service.cancelLeave('req-1', 'emp-1');

      expect(updated.status).toBe(LeaveStatus.CANCELLED);
      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-2026' },
        data: { pendingDays: { decrement: 2 }, remainingDays: { increment: 2 } },
      });
    });
  });

  describe('balances', () => {
    it('getEmployeeBalances returns existing balances', async () => {
      prisma.leaveBalance.findMany.mockResolvedValue([{ id: 'bal-1', year: 2026 }]);

      const balances = await service.getEmployeeBalances('emp-1', 2026);

      expect(balances).toHaveLength(1);
      expect(prisma.leaveBalance.create).not.toHaveBeenCalled();
    });

    it('getEmployeeBalances lazily initialises from leave types', async () => {
      prisma.leaveBalance.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'bal-1', year: 2026 }]);
      prisma.leaveType.findMany.mockResolvedValue([
        { id: 'lt-1', defaultDaysPerYear: 25 },
        { id: 'lt-2', defaultDaysPerYear: 10 },
      ]);
      prisma.leaveBalance.create.mockImplementation(({ data }: any) => ({ id: `bal-${data.leaveTypeId}` }));

      const balances = await service.getEmployeeBalances('emp-1', 2026);

      expect(prisma.leaveBalance.create).toHaveBeenCalledTimes(2);
      expect(prisma.leaveBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ employeeId: 'emp-1', year: 2026, allocatedDays: 25 }),
      });
      expect(balances).toHaveLength(1);
    });

    it('reconcileBalance throws for an unknown balance', async () => {
      prisma.leaveBalance.findUnique.mockResolvedValue(null);

      await expect(service.reconcileBalance('nope')).rejects.toThrow(NotFoundException);
    });

    it('reconcileBalance recomputes used/pending from the request source of truth', async () => {
      prisma.leaveBalance.findUnique.mockResolvedValue({
        id: 'bal-1',
        employeeId: 'emp-1',
        leaveTypeId: 'lt-1',
        year: 2026,
        allocatedDays: 25,
        usedDays: 99, // stale denormalised values
        pendingDays: 99,
        remainingDays: 0,
        leaveType: { id: 'lt-1', name: 'Annual', code: 'ANNUAL' },
      });
      prisma.leaveRequest.findMany.mockResolvedValue([
        // APPROVED Mon-Wed 2026-10-12..14 -> 3 used days
        {
          id: 'r1',
          startDate: new Date('2026-10-12T00:00:00Z'),
          endDate: new Date('2026-10-14T00:00:00Z'),
          status: LeaveStatus.APPROVED,
        },
        // PENDING Mon-Tue 2026-11-02..03 -> 2 pending days
        {
          id: 'r2',
          startDate: new Date('2026-11-02T00:00:00Z'),
          endDate: new Date('2026-11-03T00:00:00Z'),
          status: LeaveStatus.PENDING,
        },
        // APPROVED cross-year 2026-12-30..2027-01-05 -> 2 used days in 2026
        {
          id: 'r3',
          startDate: new Date('2026-12-30T00:00:00Z'),
          endDate: new Date('2027-01-05T00:00:00Z'),
          status: LeaveStatus.APPROVED,
        },
      ]);
      prisma.holiday.findMany.mockResolvedValue([]);
      prisma.leaveBalance.update.mockImplementation(({ data }: any) => ({ id: 'bal-1', ...data }));

      const result = await service.reconcileBalance('bal-1', 'hr-1');

      expect(prisma.leaveBalance.update).toHaveBeenCalledWith({
        where: { id: 'bal-1' },
        data: { usedDays: 5, pendingDays: 2, remainingDays: 18 },
      });
      expect(result.before).toEqual({ usedDays: 99, pendingDays: 99, remainingDays: 0 });
      expect(result.after).toEqual({ usedDays: 5, pendingDays: 2, remainingDays: 18 });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'LEAVE_BALANCE_RECONCILE' }),
      );
    });
  });

  describe('scoped reads', () => {
    it('HR viewers see all requests (optional employee filter)', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([{ id: 'req-1' }]);
      prisma.leaveRequest.count.mockResolvedValue(1);

      const res = await service.getLeaveRequests(viewer({ roles: [SystemRole.HR_ADMIN] }), {});

      expect(res.data.items).toHaveLength(1);
      expect(res.data.meta.total).toBe(1);
      expect(prisma.leaveRequest.findMany.mock.calls[0][0].where).not.toHaveProperty('employeeId');
    });

    it('employees without an employee profile are rejected', async () => {
      await expect(
        service.getLeaveRequests(viewer({ employeeId: undefined }), {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('employees are scoped to their own requests', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.leaveRequest.count.mockResolvedValue(0);

      await service.getLeaveRequests(viewer(), {});

      expect(prisma.leaveRequest.findMany.mock.calls[0][0].where.employeeId).toBe('emp-1');
    });

    it('managers see their team plus themselves', async () => {
      prisma.employee.findMany.mockResolvedValue([{ id: 'emp-2' }]);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.leaveRequest.count.mockResolvedValue(0);

      await service.getLeaveRequests(viewer({ employeeId: 'mgr-1', roles: [SystemRole.MANAGER] }), {});

      expect(prisma.leaveRequest.findMany.mock.calls[0][0].where.employeeId).toEqual({
        in: ['mgr-1', 'emp-2'],
      });
    });

    it('managers cannot filter to employees outside their team', async () => {
      prisma.employee.findMany.mockResolvedValue([{ id: 'emp-2' }]);

      await expect(
        service.getLeaveRequests(
          viewer({ employeeId: 'mgr-1', roles: [SystemRole.MANAGER] }),
          { employeeId: 'emp-9' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('getLeaveRequestById throws for an unknown request', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(null);

      await expect(service.getLeaveRequestById('nope', viewer())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getLeaveRequestById enforces ownership', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        pendingRequest({ employee: { id: 'emp-1', managerId: 'mgr-1' } }),
      );

      await expect(
        service.getLeaveRequestById('req-1', viewer({ employeeId: 'emp-2' })),
      ).rejects.toThrow(ForbiddenException);

      const own = await service.getLeaveRequestById('req-1', viewer());
      expect(own.id).toBe('req-1');
    });

    it('getLeaveRequestById allows the manager of the requester', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        pendingRequest({ employee: { id: 'emp-1', managerId: 'mgr-1' } }),
      );

      const req = await service.getLeaveRequestById(
        'req-1',
        viewer({ employeeId: 'mgr-1', roles: [SystemRole.MANAGER] }),
      );
      expect(req.id).toBe('req-1');
    });

    it('HR viewers bypass ownership checks', async () => {
      prisma.leaveRequest.findUnique.mockResolvedValue(
        pendingRequest({ employee: { id: 'emp-1', managerId: 'mgr-1' } }),
      );

      const req = await service.getLeaveRequestById(
        'req-1',
        viewer({ roles: [SystemRole.HR_ADMIN] }),
      );
      expect(req.id).toBe('req-1');
    });
  });

  describe('leave types & holidays', () => {
    it('getLeaveTypes returns types ordered by name', async () => {
      prisma.leaveType.findMany.mockResolvedValue([{ id: 'lt-1', name: 'Annual' }]);

      const types = await service.getLeaveTypes();

      expect(types).toHaveLength(1);
      expect(prisma.leaveType.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
    });

    it('getHolidays returns holidays ordered by date', async () => {
      prisma.holiday.findMany.mockResolvedValue([{ id: 'h-1' }]);

      const holidays = await service.getHolidays();

      expect(holidays).toHaveLength(1);
    });

    it('createLeaveType rejects duplicate codes', async () => {
      prisma.leaveType.findUnique.mockResolvedValue({ id: 'lt-1', code: 'ANNUAL' });

      await expect(
        service.createLeaveType({ name: 'Annual', code: 'annual', type: 'ANNUAL', defaultDaysPerYear: 25 } as any),
      ).rejects.toThrow(/already exists/i);
    });

    it('createLeaveType uppercases the code and audits', async () => {
      prisma.leaveType.findUnique.mockResolvedValue(null);
      prisma.leaveType.create.mockImplementation(({ data }: any) => ({ id: 'lt-new', ...data }));

      const created = await service.createLeaveType(
        { name: 'Annual', code: 'annual', type: 'ANNUAL', defaultDaysPerYear: 25 } as any,
        'hr-1',
        'hr@ems.local',
      );

      expect(created.code).toBe('ANNUAL');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.CREATE, entityType: 'LEAVE_TYPE' }),
      );
    });

    it('createHoliday upserts on the normalised date', async () => {
      prisma.holiday.upsert.mockResolvedValue({ id: 'h-1' });

      await service.createHoliday({ title: 'Christmas', date: '2026-12-25' } as any);

      expect(prisma.holiday.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { date: new Date('2026-12-25T00:00:00Z') },
        }),
      );
    });
  });
});
