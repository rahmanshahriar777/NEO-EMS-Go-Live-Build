/**
 * Leave approval flow — cohesive scenario test (unit level, mocked Prisma).
 *
 * Complements leaves.service.spec.ts (which tests each method in isolation)
 * by walking the full lifecycle in one place:
 *   request -> manager approve -> balance decremented, approver USER id in
 *     the audit trail (B4), requester + approver notified;
 *   non-manager approve -> 403 at the role gate (service never reached);
 *   non-line-manager approve -> 403 at the service rule (A2);
 *   self-approve -> 403 even for a manager.
 *
 * All dates are real calendar fixtures: 2026-10-12..14 = Mon..Wed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { LeavesService } from './leaves.service';
import { LeavesController } from './leaves.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LeaveStatus, SystemRole, JwtPayload } from '@ems/shared';

describe('leave approval flow', () => {
  let service: LeavesService;
  let prisma: any;
  let tx: any;
  let audit: any;
  let notifications: any;

  const EMP_ID = 'emp-1';
  const MGR_ID = 'mgr-1';
  const MGR_USER_ID = 'user-mgr';
  const EMP_USER_ID = 'user-emp';
  const LT_ID = 'lt-annual';

  /** Mutable in-memory balance so the flow asserts real state transitions. */
  let balance: { id: string; remainingDays: number; usedDays: number; pendingDays: number };

  beforeEach(async () => {
    balance = { id: 'bal-1', remainingDays: 25, usedDays: 0, pendingDays: 0 };

    prisma = {
      leaveType: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
      leaveBalance: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      leaveRequest: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      leaveApproval: { create: jest.fn() },
      holiday: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
      employee: { findMany: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    tx = {
      leaveRequest: prisma.leaveRequest,
      leaveBalance: prisma.leaveBalance,
      leaveType: prisma.leaveType,
      holiday: prisma.holiday,
      leaveApproval: prisma.leaveApproval,
      employee: prisma.employee,
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));
    audit = { log: jest.fn() };
    notifications = { createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }) };

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

  /** Installs the in-memory balance read/write mocks. */
  function installBalanceMocks() {
    prisma.leaveBalance.findUnique.mockResolvedValue({ ...balance });
    prisma.leaveBalance.update.mockImplementation(({ data }: any) => {
      if (data.pendingDays?.increment) {
        balance.pendingDays += data.pendingDays.increment;
        balance.remainingDays -= data.pendingDays.increment;
      }
      if (data.pendingDays?.decrement) {
        balance.pendingDays -= data.pendingDays.decrement;
      }
      if (data.usedDays?.increment) balance.usedDays += data.usedDays.increment;
      if (data.remainingDays?.increment) balance.remainingDays += data.remainingDays.increment;
      return { ...balance };
    });
  }

  /** Request: Mon 2026-10-12 .. Wed 2026-10-14 = 3 working days. */
  async function requestLeave() {
    prisma.leaveRequest.findFirst.mockResolvedValue(null); // no overlap
    installBalanceMocks();
    prisma.leaveRequest.create.mockImplementation(({ data }: any) => ({
      id: 'req-1',
      ...data,
      employee: { id: EMP_ID, managerId: MGR_ID },
    }));

    return service.createLeaveRequest(EMP_ID, {
      leaveTypeId: LT_ID,
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      reason: 'flow test',
    } as any);
  }

  function mockPendingRequestForApproval() {
    installBalanceMocks();
    prisma.leaveRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      employeeId: EMP_ID,
      leaveTypeId: LT_ID,
      startDate: new Date('2026-10-12T00:00:00Z'),
      endDate: new Date('2026-10-14T00:00:00Z'),
      totalDays: 3,
      status: LeaveStatus.PENDING,
      employee: { id: EMP_ID, managerId: MGR_ID, userId: EMP_USER_ID },
    });
    // B4: the approver's USER id is resolved from the employee record when
    // the caller does not pass it explicitly.
    prisma.employee.findUnique.mockResolvedValue({ userId: MGR_USER_ID });
    prisma.leaveRequest.update.mockImplementation(({ data }: any) => ({ id: 'req-1', ...data }));
    prisma.leaveApproval.create.mockImplementation(({ data }: any) => ({ id: 'appr-1', ...data }));
  }

  it('request -> manager approve -> balance decremented, USER id audited, parties notified', async () => {
    const created = await requestLeave();
    expect(created.totalDays).toBe(3);
    expect(balance.pendingDays).toBe(3);
    expect(balance.remainingDays).toBe(22);

    mockPendingRequestForApproval();
    const approved = await service.approveOrReject(
      'req-1',
      MGR_ID,
      { status: LeaveStatus.APPROVED } as any,
      'mgr@ems.local',
      undefined, // caller omits the user id: resolved from the employee record (B4)
      [SystemRole.MANAGER],
    );

    expect(approved.status).toBe(LeaveStatus.APPROVED);
    expect(balance.pendingDays).toBe(0);
    expect(balance.usedDays).toBe(3);
    expect(balance.remainingDays).toBe(22);

    // Approval row carries the approver's employee id AND user id (B4).
    expect(prisma.leaveApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        leaveRequestId: 'req-1',
        approverId: MGR_ID,
        approverUserId: MGR_USER_ID,
      }),
    });
    // The audit trail records the approver's USER id, not the employee id (B4).
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: MGR_USER_ID, entityId: 'req-1' }),
      expect.anything(),
    );
    // Requester and approver are notified (best-effort, post-commit).
    expect(notifications.createNotification).toHaveBeenCalledWith(
      EMP_USER_ID,
      expect.stringContaining('approved'),
      expect.anything(),
      '/leave-requests/req-1',
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      MGR_USER_ID,
      expect.stringContaining('approved'),
      expect.anything(),
      '/leave-requests/req-1',
    );
  });

  it('non-manager approve -> 403 at the role gate (service never reached)', () => {
    const guard = new RolesGuard(new Reflector());
    const handler = (LeavesController.prototype as any).approveLeave;
    const ctx = {
      getHandler: () => handler,
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: 'user-emp', roles: [SystemRole.EMPLOYEE] } as JwtPayload,
        }),
      }),
    } as any;

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(prisma.leaveRequest.findUnique).not.toHaveBeenCalled();
  });

  it('non-line-manager approve -> 403 at the service rule (A2)', async () => {
    mockPendingRequestForApproval();

    await expect(
      service.approveOrReject('req-1', 'mgr-other', { status: LeaveStatus.APPROVED } as any, undefined, 'user-other', [
        SystemRole.MANAGER,
      ]),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.leaveApproval.create).not.toHaveBeenCalled();
    expect(balance.pendingDays).toBe(0);
  });

  it('HR approve passes the A2 rule without being the line manager', async () => {
    mockPendingRequestForApproval();

    const approved = await service.approveOrReject(
      'req-1',
      'hr-1',
      { status: LeaveStatus.APPROVED } as any,
      'hr@ems.local',
      'user-hr',
      [SystemRole.HR_ADMIN],
    );

    expect(approved.status).toBe(LeaveStatus.APPROVED);
    expect(balance.usedDays).toBe(3);
  });

  it('self-approve -> 403 even when the approver holds a manager role', async () => {
    mockPendingRequestForApproval();

    await expect(
      service.approveOrReject('req-1', EMP_ID, { status: LeaveStatus.APPROVED } as any),
    ).rejects.toThrow(ForbiddenException);
    // No balance mutation, no approval row, no notifications on self-approval.
    expect(balance.pendingDays).toBe(0);
    expect(prisma.leaveApproval.create).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('reject releases the pending reservation back to remaining', async () => {
    await requestLeave();
    expect(balance.pendingDays).toBe(3);

    mockPendingRequestForApproval();
    await service.approveOrReject('req-1', MGR_ID, { status: LeaveStatus.REJECTED } as any, undefined, undefined, [
      SystemRole.MANAGER,
    ]);

    expect(balance.pendingDays).toBe(0);
    expect(balance.usedDays).toBe(0);
    expect(balance.remainingDays).toBe(25);
  });
});
