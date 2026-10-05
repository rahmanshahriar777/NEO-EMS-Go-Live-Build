import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { pickKnownColumns } from '../../core/prisma/schema-compat.util';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateLeaveRequestDto,
  ApproveLeaveDto,
  CreateLeaveTypeDto,
  CreateHolidayDto,
  CreateLeavePolicyDto,
} from './dto/leave.dto';
import { workingDaysPerYear, startOfDay } from './holidays';
import {
  LeaveStatus,
  AuditAction,
  SystemRole,
  JwtPayload,
  createPaginatedResponse,
} from '@ems/shared';

export interface LeaveViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

export function toLeaveViewer(user: JwtPayload): LeaveViewer {
  return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
}

function isHrOrAdmin(roles: string[]): boolean {
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

export interface ApprovalChainStep {
  step: number;
  role: 'MANAGER' | 'HR';
  approverEmployeeId?: string;
  approvedAt?: string;
}

/**
 * ASSUMPTION (Phase 2, item 6 — approval chains): a leave request of more
 * than 5 working days requires a second approval step from HR after the
 * line manager. Single-step requests behave exactly as before.
 */
const HR_CHAIN_THRESHOLD_DAYS = 5;

export function buildApprovalChain(totalDays: number): ApprovalChainStep[] {
  const chain: ApprovalChainStep[] = [{ step: 0, role: 'MANAGER' }];
  if (totalDays > HR_CHAIN_THRESHOLD_DAYS) {
    chain.push({ step: 1, role: 'HR' });
  }
  return chain;
}

@Injectable()
export class LeavesService {
  private readonly logger = new Logger(LeavesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Leave Types & Balances
  // ---------------------------------------------------------------------------

  async getLeaveTypes() {
    return this.prisma.leaveType.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async createLeaveType(dto: CreateLeaveTypeDto, actorId?: string, actorEmail?: string) {
    const existing = await this.prisma.leaveType.findUnique({
      where: { code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new BadRequestException(`Leave type with code '${dto.code}' already exists`);
    }

    const created = await this.prisma.leaveType.create({
      data: {
        name: dto.name,
        code: dto.code.toUpperCase(),
        type: dto.type as any,
        defaultDaysPerYear: dto.defaultDaysPerYear,
        isPaid: dto.isPaid ?? true,
        description: dto.description,
      },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'LEAVE_TYPE',
      entityId: created.id,
      afterState: created,
    });

    return created;
  }

  // ---------------------------------------------------------------------------
  // Leave Policies v2 (Phase 2, item 6)
  //
  // Schema need (worker 4) — new model LeavePolicy:
  //   id String @id @default(uuid()); leaveTypeId String @unique;
  //   accrualPerMonth Decimal? @db.Decimal(5,2); carryOverCap Decimal? @db.Decimal(5,1);
  //   workingDays Int[] @default([1,2,3,4,5]); maxConsecutiveDays Int?;
  //   requiresHrApproval Boolean @default(false); createdAt/updatedAt DateTime
  // Until the migration lands, policy reads return null and defaults apply.
  // ---------------------------------------------------------------------------

  /** Reads the policy for a leave type; null when the table is not migrated. */
  private async getLeavePolicy(tx: any, leaveTypeId: string): Promise<any | null> {
    try {
      return await (tx as any).leavePolicy.findUnique({ where: { leaveTypeId } });
    } catch (error) {
      this.logger.warn(`LeavePolicy table unavailable, using defaults: ${(error as Error).message}`);
      return null;
    }
  }

  async getLeavePolicies() {
    try {
      return await (this.prisma as any).leavePolicy.findMany({
        include: { leaveType: { select: { id: true, name: true, code: true } } },
        orderBy: { createdAt: 'asc' },
      });
    } catch (error) {
      this.logger.warn(`LeavePolicy table unavailable: ${(error as Error).message}`);
      return [];
    }
  }

  async upsertLeavePolicy(dto: CreateLeavePolicyDto, actorId?: string, actorEmail?: string) {
    const data = {
      leaveTypeId: dto.leaveTypeId,
      ...(dto.accrualPerMonth !== undefined && { accrualPerMonth: dto.accrualPerMonth }),
      ...(dto.carryOverCap !== undefined && { carryOverCap: dto.carryOverCap }),
      ...(dto.workingDays !== undefined && { workingDays: dto.workingDays }),
      ...(dto.maxConsecutiveDays !== undefined && { maxConsecutiveDays: dto.maxConsecutiveDays }),
      ...(dto.requiresHrApproval !== undefined && { requiresHrApproval: dto.requiresHrApproval }),
    };
    const policy = await (this.prisma as any).leavePolicy.upsert({
      where: { leaveTypeId: dto.leaveTypeId },
      update: data,
      create: data,
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'LEAVE_POLICY',
      entityId: policy.id,
      afterState: policy,
    });

    return policy;
  }

  /**
   * Annual carry-over (Phase 2, item 6): moves unused days from `fromYear`
   * into `toYear` balances, capped per policy.
   *
   * ASSUMPTIONS (documented; counsel/HR sign-off pending):
   * - Default carry-over cap is 5 days when no policy exists.
   * - Carried days are added to the target year's allocated/remaining days.
   * - Carried days expiring at end of Q1 is NOT enforced yet — reported as
   *   follow-up (needs a LeaveBalance.carriedDaysExpiresAt column).
   */
  async applyAnnualCarryOver(
    fromYear: number,
    toYear: number,
    actorId?: string,
    actorEmail?: string,
  ) {
    const results: Array<{
      employeeId: string;
      leaveTypeId: string;
      carriedDays: number;
      cap: number;
    }> = [];

    await this.prisma.$transaction(async (tx) => {
      const balances = await tx.leaveBalance.findMany({
        where: { year: fromYear },
        select: { id: true, employeeId: true, leaveTypeId: true, remainingDays: true },
      });

      for (const balance of balances) {
        const policy = await this.getLeavePolicy(tx, balance.leaveTypeId);
        const cap = policy?.carryOverCap != null ? Number(policy.carryOverCap) : 5;
        const unused = Math.max(0, Number(balance.remainingDays));
        const carried = Math.min(unused, cap);
        if (carried <= 0) continue;

        const target = await this.ensureBalance(tx, balance.employeeId, balance.leaveTypeId, toYear);
        await tx.leaveBalance.update({
          where: { id: target.id },
          data: {
            allocatedDays: { increment: carried },
            remainingDays: { increment: carried },
          },
        });
        results.push({
          employeeId: balance.employeeId,
          leaveTypeId: balance.leaveTypeId,
          carriedDays: carried,
          cap,
        });
      }

      await this.audit.log(
        {
          actorId,
          actorEmail,
          action: AuditAction.UPDATE,
          entityType: 'LEAVE_CARRY_OVER',
          entityId: `${fromYear}-to-${toYear}`,
          afterState: { fromYear, toYear, applied: results.length, results },
        },
        tx as any,
      );
    });

    return { fromYear, toYear, applied: results.length, results };
  }

  async getEmployeeBalances(employeeId: string, year: number = new Date().getFullYear()) {
    let balances = await this.prisma.leaveBalance.findMany({
      where: { employeeId, year },
      include: { leaveType: true },
    });

    // If balances don't exist yet for this year, lazily initialize from leave types
    if (balances.length === 0) {
      const leaveTypes = await this.prisma.leaveType.findMany();
      for (const lt of leaveTypes) {
        await this.prisma.leaveBalance.create({
          data: {
            employeeId,
            leaveTypeId: lt.id,
            year,
            allocatedDays: lt.defaultDaysPerYear,
            remainingDays: lt.defaultDaysPerYear,
            usedDays: 0,
            pendingDays: 0,
          },
        });
      }

      balances = await this.prisma.leaveBalance.findMany({
        where: { employeeId, year },
        include: { leaveType: true },
      });
    }

    return balances;
  }

  /**
   * Reconciles a denormalised LeaveBalance against the source of truth: the
   * APPROVED and PENDING leave requests charged to that (employee, type, year).
   * Cross-year requests are split per year using working-day counting, the
   * same rule as creation/approval, so the invariant
   * remaining = allocated − used − pending is restored. (§5.2)
   */
  async reconcileBalance(balanceId: string, actorId?: string, actorEmail?: string) {
    const balance = await this.prisma.leaveBalance.findUnique({
      where: { id: balanceId },
      include: { leaveType: { select: { id: true, name: true, code: true } } },
    });
    if (!balance) throw new NotFoundException(`Leave balance #${balanceId} not found`);

    const requests = await this.prisma.leaveRequest.findMany({
      where: {
        employeeId: balance.employeeId,
        leaveTypeId: balance.leaveTypeId,
        status: { in: [LeaveStatus.PENDING as any, LeaveStatus.APPROVED as any] },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    });

    let usedDays = 0;
    let pendingDays = 0;
    if (requests.length > 0) {
      const dates = requests.flatMap((r) => [r.startDate, r.endDate]);
      const min = new Date(Math.min(...dates.map((d) => d.getTime())));
      const max = new Date(Math.max(...dates.map((d) => d.getTime())));
      const holidays = await this.prisma.holiday.findMany({
        where: { date: { gte: startOfDay(min), lte: startOfDay(max) } },
        select: { date: true },
      });
      const holidayDates = holidays.map((h) => h.date);

      for (const req of requests) {
        // halfDay is a new column (worker 4 migration); read defensively.
        // Cross-year requests are split per year — only this balance's year counts.
        const days = this.countRequestDays(req as any, holidayDates, undefined, balance.year);
        if (req.status === (LeaveStatus.APPROVED as any)) usedDays += days;
        else pendingDays += days;
      }
    }

    const allocated = Number(balance.allocatedDays);
    const remaining = Math.max(0, allocated - usedDays - pendingDays);

    const before = {
      usedDays: Number(balance.usedDays),
      pendingDays: Number(balance.pendingDays),
      remainingDays: Number(balance.remainingDays),
    };

    const updated = await this.prisma.leaveBalance.update({
      where: { id: balanceId },
      data: { usedDays, pendingDays, remainingDays: remaining },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'LEAVE_BALANCE_RECONCILE',
      entityId: balanceId,
      beforeState: before,
      afterState: {
        usedDays,
        pendingDays,
        remainingDays: remaining,
      },
    });

    return {
      balanceId,
      employeeId: balance.employeeId,
      leaveType: balance.leaveType,
      year: balance.year,
      before,
      after: { usedDays, pendingDays, remainingDays: remaining },
    };
  }

  /** Day count for one request: half-day requests consume 0.5 days. */
  private countRequestDays(
    req: { startDate: Date; endDate: Date; halfDay?: boolean | null },
    holidayDates: Date[],
    workingDays?: number[],
    year?: number,
  ): number {
    if (req.halfDay) return 0.5;
    const segments = workingDaysPerYear(req.startDate, req.endDate, holidayDates, workingDays);
    return segments
      .filter((s) => year === undefined || s.year === year)
      .reduce((sum, s) => sum + s.days, 0);
  }

  // ---------------------------------------------------------------------------
  // Leave Requests & Approvals
  // ---------------------------------------------------------------------------

  /**
   * Scoped + paginated list (F14/F24). HR/admin see everything (optional
   * employeeId filter); managers see their team + themselves; employees see
   * only their own requests.
   */
  async getLeaveRequests(
    viewer: LeaveViewer,
    opts: { status?: LeaveStatus; employeeId?: string; page?: number; limit?: number },
  ) {
    const { status, page = 1, limit = 20 } = opts;
    const skip = (page - 1) * limit;

    const where: any = {
      ...(status && { status: status as any }),
    };

    if (isHrOrAdmin(viewer.roles)) {
      if (opts.employeeId) where.employeeId = opts.employeeId;
    } else {
      if (!viewer.employeeId) {
        throw new ForbiddenException('User is not associated with an employee profile');
      }
      if (viewer.roles.includes(SystemRole.MANAGER)) {
        const reports = await this.prisma.employee.findMany({
          where: { managerId: viewer.employeeId, deletedAt: null },
          select: { id: true },
        });
        const visibleIds = [viewer.employeeId, ...reports.map((r) => r.id)];
        if (opts.employeeId) {
          if (!visibleIds.includes(opts.employeeId)) {
            throw new ForbiddenException('You do not have access to this employee leave requests');
          }
          where.employeeId = opts.employeeId;
        } else {
          where.employeeId = { in: visibleIds };
        }
      } else {
        where.employeeId = viewer.employeeId;
      }
    }

    const [items, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
          leaveType: { select: { id: true, name: true, code: true } },
          approvals: {
            include: {
              approver: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: { actionDate: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }

  /** Ownership-checked get (F14). */
  async getLeaveRequestById(id: string, viewer: LeaveViewer) {
    const req = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeNumber: true,
            managerId: true,
          },
        },
        leaveType: { select: { id: true, name: true, code: true } },
        approvals: {
          include: { approver: { select: { id: true, firstName: true, lastName: true } } },
          orderBy: { actionDate: 'desc' },
        },
      },
    });
    if (!req) {
      throw new NotFoundException(`Leave request #${id} not found`);
    }

    if (!isHrOrAdmin(viewer.roles)) {
      if (!viewer.employeeId) {
        throw new ForbiddenException('User is not associated with an employee profile');
      }
      const isOwner = req.employeeId === viewer.employeeId;
      const isManagerOfOwner =
        viewer.roles.includes(SystemRole.MANAGER) && req.employee.managerId === viewer.employeeId;
      if (!isOwner && !isManagerOfOwner) {
        throw new ForbiddenException('You do not have access to this leave request');
      }
    }

    return req;
  }

  /**
   * Creates a leave request with (F14):
   * - overlap detection against PENDING/APPROVED ranges,
   * - working-day counting (working-week pattern minus holidays),
   * - cross-year requests split across each year's balance,
   * - half-day requests (0.5 day, single working day),
   * - team clash warnings (non-blocking),
   * - approval-chain initialisation for long requests.
   */
  async createLeaveRequest(employeeId: string, dto: CreateLeaveRequestDto) {
    const start = startOfDay(new Date(dto.startDate));
    const end = startOfDay(new Date(dto.endDate));

    if (end < start) {
      throw new BadRequestException('End date cannot be prior to start date');
    }

    if (dto.halfDay && start.getTime() !== end.getTime()) {
      throw new BadRequestException('Half-day leave must be a single day');
    }
    if (dto.halfDay && dto.halfDayPeriod && !['AM', 'PM'].includes(dto.halfDayPeriod)) {
      throw new BadRequestException("halfDayPeriod must be 'AM' or 'PM'");
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Per-employee transaction advisory lock to guarantee overlap atomicity and prevent TOCTOU under concurrent creates
      if (typeof (tx as any).$executeRaw === 'function') {
        try {
          await (tx as any).$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'leave-overlap-' + employeeId}))`;
        } catch {
          // Graceful fallback for mock/in-memory test environments
        }
        try {
          await (tx as any).$executeRaw`SELECT 1 FROM "employees" WHERE id = ${employeeId} FOR UPDATE`;
        } catch {
          // Graceful fallback for mock/in-memory test environments
        }
      }

      // --- Overlap detection: reject ranges intersecting PENDING/APPROVED ones.
      const overlapping = await tx.leaveRequest.findFirst({
        where: {
          employeeId,
          status: { in: [LeaveStatus.PENDING as any, LeaveStatus.APPROVED as any] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { id: true, startDate: true, endDate: true, status: true },
      });
      if (overlapping) {
        throw new ConflictException(
          `Leave request overlaps with existing ${overlapping.status} request ` +
            `(${overlapping.startDate.toISOString().slice(0, 10)} – ` +
            `${overlapping.endDate.toISOString().slice(0, 10)})`,
        );
      }

      const holidays = await tx.holiday.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true },
      });
      const holidayDates = holidays.map((h) => h.date);

      // Working-week pattern from the leave policy when configured.
      const policy = await this.getLeavePolicy(tx, dto.leaveTypeId);
      const workingDays: number[] | undefined = policy?.workingDays ?? undefined;

      let totalDays: number;
      let segments: Array<{ year: number; days: number }>;
      if (dto.halfDay) {
        const wd = workingDaysPerYear(start, end, holidayDates, workingDays);
        if (wd.length === 0 || wd[0].days === 0) {
          throw new BadRequestException('Half-day leave must fall on a working day');
        }
        totalDays = 0.5;
        segments = [{ year: start.getUTCFullYear(), days: 0.5 }];
      } else {
        segments = workingDaysPerYear(start, end, holidayDates, workingDays);
        totalDays = segments.reduce((sum, s) => sum + s.days, 0);
      }

      if (totalDays <= 0) {
        throw new BadRequestException(
          'The requested range contains no working days (weekends/holidays only)',
        );
      }

      if (policy?.maxConsecutiveDays != null && totalDays > Number(policy.maxConsecutiveDays)) {
        throw new BadRequestException(
          `Leave request exceeds the policy maximum of ${policy.maxConsecutiveDays} consecutive days`,
        );
      }

      // --- Reserve from each year's balance (cross-year split).
      for (const seg of segments) {
        const balance = await this.ensureBalance(tx, employeeId, dto.leaveTypeId, seg.year);
        if (Number(balance.remainingDays) < seg.days) {
          throw new BadRequestException(
            `Insufficient leave balance for ${seg.year}. Requested: ${seg.days} days, ` +
              `Remaining: ${balance.remainingDays} days`,
          );
        }
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: {
            pendingDays: { increment: seg.days },
            remainingDays: { decrement: seg.days },
          },
        });
      }

      // Approval chain (Phase 2, item 6): persisted only for multi-step
      // chains so the common single-step path needs no new columns.
      const chain = buildApprovalChain(totalDays);
      const chainData =
        chain.length > 1
          ? await pickKnownColumns(
              tx,
              'leave_requests',
              { approvalChain: chain, currentStep: 0 },
              'LeavesService.createLeaveRequest',
            )
          : {};

      const halfDayData = dto.halfDay
        ? await pickKnownColumns(
            tx,
            'leave_requests',
            { halfDay: true, halfDayPeriod: dto.halfDayPeriod ?? null },
            'LeavesService.createLeaveRequest',
          )
        : {};

      const request = await tx.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: dto.leaveTypeId,
          startDate: start,
          endDate: end,
          totalDays,
          reason: dto.reason,
          status: LeaveStatus.PENDING as any,
          ...halfDayData,
          ...chainData,
        } as any,
        include: {
          leaveType: { select: { id: true, name: true, code: true } },
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
        },
      });

      // --- Team clash warnings (non-blocking): teammates with APPROVED leave
      // overlapping this range.
      const warnings = await this.buildClashWarnings(tx, employeeId, start, end);

      return { ...request, totalDays: Number(request.totalDays), warnings };
    });

    // Post-commit: notify the requester's line manager (best-effort; the
    // request is the source of truth and must not be rolled back by a
    // notification failure).
    try {
      const requester = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { manager: { select: { userId: true } } },
      });
      const managerUserId = (requester as any)?.manager?.userId;
      if (managerUserId) {
        const when = `${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)}`;
        const name =
          `${(created as any)?.employee?.firstName ?? ''} ${(created as any)?.employee?.lastName ?? ''}`.trim();
        await this.notifications.createNotification(
          managerUserId,
          'New leave request',
          `${name} requested leave for ${when}.`,
          `/leave-requests/${(created as any).id}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Leave-request manager notification failed (non-blocking): ${(error as Error).message}`,
      );
    }

    return created;
  }

  /**
   * Team clash warnings: approved leave of teammates (same line manager,
   * excluding the requester) overlapping [start, end].
   */
  private async buildClashWarnings(
    tx: any,
    employeeId: string,
    start: Date,
    end: Date,
  ): Promise<Array<{ employeeId: string; name: string; startDate: string; endDate: string }>> {
    try {
      const me = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { managerId: true },
      });
      if (!me?.managerId) return [];
      const clashes = await tx.leaveRequest.findMany({
        where: {
          employeeId: { not: employeeId },
          status: LeaveStatus.APPROVED as any,
          startDate: { lte: end },
          endDate: { gte: start },
          employee: { managerId: me.managerId },
        },
        select: {
          employeeId: true,
          startDate: true,
          endDate: true,
          employee: { select: { firstName: true, lastName: true } },
        },
        take: 25,
      });
      return clashes.map((c: any) => ({
        employeeId: c.employeeId,
        name: `${c.employee.firstName} ${c.employee.lastName}`,
        startDate: c.startDate.toISOString().slice(0, 10),
        endDate: c.endDate.toISOString().slice(0, 10),
      }));
    } catch (error) {
      this.logger.warn(`Clash-warning lookup failed (non-blocking): ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * A2 + B4: approve or reject a leave request.
   *
   * - A2: the approver must be the requester's line manager or HR/SUPER_ADMIN.
   * - B4: the approver's USER id (not employee id) is written to the audit
   *   trail — AuditLog.actorId and the new LeaveApproval.approverUserId
   *   column (worker 4 migration; the legacy approverId/employee column is
   *   kept for backward compatibility).
   * - Approval chains: intermediate approvals advance currentStep and keep
   *   the request PENDING; only the final step moves balances and flips the
   *   status. Rejection at any step releases the pending days.
   * - Notifications: requester and approver are notified via the
   *   notifications module (best-effort, post-commit).
   * - The audit row is written inside the same transaction (tx passed).
   */
  async approveOrReject(
    requestId: string,
    approverEmployeeId: string,
    dto: ApproveLeaveDto,
    actorEmail?: string,
    approverUserId?: string,
    approverRoles: string[] = [],
  ) {
    let result: any;
    let notify: {
      requesterUserId?: string;
      approverUserId?: string;
      status: LeaveStatus;
      startDate: Date;
      endDate: Date;
    } | null = null;

    await this.prisma.$transaction(async (tx) => {
      const request = await tx.leaveRequest.findUnique({
        where: { id: requestId },
        include: {
          employee: { select: { id: true, managerId: true, userId: true } },
        },
      });

      // Row lock on the leave request so concurrent approvers serialize
      if (typeof (tx as any).$executeRaw === 'function') {
        try {
          await (tx as any).$executeRaw`SELECT 1 FROM "leave_requests" WHERE id = ${requestId} FOR UPDATE`;
        } catch {
          // Graceful fallback for mock/in-memory test environments
        }
      }

      if (!request) {
        throw new NotFoundException(`Leave request #${requestId} not found`);
      }

      if (request.status !== (LeaveStatus.PENDING as any)) {
        throw new BadRequestException(`Leave request has already been ${request.status}`);
      }

      // Self-approval block (F14): approver must differ from requester.
      if (request.employeeId === approverEmployeeId) {
        throw new ForbiddenException('You cannot approve or reject your own leave request');
      }

      // A2: approver must be the requester's line manager or HR/SUPER_ADMIN.
      const hr = isHrOrAdmin(approverRoles);
      const isManagerOfRequester = (request.employee as any)?.managerId === approverEmployeeId;
      if (!hr && !isManagerOfRequester) {
        throw new ForbiddenException(
          'Only the requester\u2019s line manager or HR may approve or reject leave',
        );
      }

      // Resolve the approver's USER id (B4): prefer the explicit caller id,
      // else the user linked to the approver's employee record.
      let resolvedApproverUserId = approverUserId;
      if (!resolvedApproverUserId) {
        const approverEmp = await tx.employee.findUnique({
          where: { id: approverEmployeeId },
          select: { userId: true },
        });
        resolvedApproverUserId = approverEmp?.userId ?? undefined;
      }

      // Approval-chain step check (Phase 2, item 6).
      const chain: ApprovalChainStep[] =
        (request as any).approvalChain ?? buildApprovalChain(Number(request.totalDays));
      const stepIndex = (request as any).currentStep ?? 0;
      const step = chain[Math.min(stepIndex, chain.length - 1)];
      const isFinalStep = stepIndex >= chain.length - 1;
      if (step?.role === 'HR' && !hr) {
        throw new ForbiddenException('This approval step requires HR');
      }

      const holidays = await tx.holiday.findMany({
        where: { date: { gte: startOfDay(request.startDate), lte: startOfDay(request.endDate) } },
        select: { date: true },
      });
      const holidayDates = holidays.map((h) => h.date);
      const days = this.countRequestDays(request as any, holidayDates);

      const balanceWhere = (year: number) => ({
        employeeId_leaveTypeId_year: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year,
        },
      });

      if (dto.status === LeaveStatus.APPROVED && isFinalStep) {
        // Final approval: pending -> used.
        const segments = (request as any).halfDay
          ? [{ year: request.startDate.getUTCFullYear(), days }]
          : workingDaysPerYear(request.startDate, request.endDate, holidayDates);
        for (const seg of segments) {
          const balance = await tx.leaveBalance.findUnique({ where: balanceWhere(seg.year) });
          if (!balance) {
            this.logger.warn(
              `Balance missing for ${request.employeeId}/${seg.year} during APPROVED; skipping segment`,
            );
            continue;
          }
          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: {
              pendingDays: { decrement: seg.days },
              usedDays: { increment: seg.days },
            },
          });
        }
      } else if (dto.status === LeaveStatus.REJECTED) {
        // Rejection at any step: pending -> remaining.
        const segments = (request as any).halfDay
          ? [{ year: request.startDate.getUTCFullYear(), days }]
          : workingDaysPerYear(request.startDate, request.endDate, holidayDates);
        for (const seg of segments) {
          const balance = await tx.leaveBalance.findUnique({ where: balanceWhere(seg.year) });
          if (!balance) {
            this.logger.warn(
              `Balance missing for ${request.employeeId}/${seg.year} during REJECTED; skipping segment`,
            );
            continue;
          }
          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: {
              pendingDays: { decrement: seg.days },
              remainingDays: { increment: seg.days },
            },
          });
        }
      }

      const nextStatus =
        dto.status === LeaveStatus.APPROVED && !isFinalStep
          ? LeaveStatus.PENDING
          : (dto.status as any);

      const stepUpdate =
        !isFinalStep && dto.status === LeaveStatus.APPROVED
          ? await pickKnownColumns(
              tx,
              'leave_requests',
              { currentStep: stepIndex + 1 },
              'LeavesService.approveOrReject',
            )
          : {};

      // v6 fix #1 — optimistic concurrency: the status transition only matches
      // while the row is STILL PENDING. Two concurrent approvers race here;
      // the loser gets P2025 and its whole transaction (including the balance
      // moves above) rolls back, so balances move exactly once. (The `as any`
      // is deliberate: Prisma's generated WhereUniqueInput type only declares
      // unique fields, but the query engine applies the whole filter —
      // `WHERE id AND status` — and throws P2025 when no row matches. Same
      // pattern as the payroll disburse guard.)
      let updatedRequest: any;
      try {
        updatedRequest = await tx.leaveRequest.update({
          where: { id: requestId, status: LeaveStatus.PENDING } as any,
          data: {
            status: nextStatus,
            ...stepUpdate,
          } as any,
        });
      } catch (e: any) {
        if (e?.code !== 'P2025') throw e;
        throw new ConflictException(
          'Leave request was already processed by another approver — please refresh and try again',
        );
      }

      const approvalExtra = await pickKnownColumns(
        tx,
        'leave_approvals',
        // B4: approver's USER id in the audit trail (column via worker 4).
        resolvedApproverUserId ? { approverUserId: resolvedApproverUserId } : {},
        'LeavesService.approveOrReject',
      );

      await tx.leaveApproval.create({
        data: {
          leaveRequestId: requestId,
          approverId: approverEmployeeId,
          ...approvalExtra,
          status: dto.status as any,
          remarks: dto.remarks,
        } as any,
      });

      await this.audit.log(
        {
          // B4: actorId is the approver's USER id (AuditLog.actorId is a User FK).
          actorId: resolvedApproverUserId,
          actorEmail,
          action: dto.status === LeaveStatus.APPROVED ? AuditAction.APPROVE : AuditAction.REJECT,
          entityType: 'LEAVE_REQUEST',
          entityId: requestId,
          afterState: {
            ...updatedRequest,
            approvalStep: stepIndex,
            finalStep: isFinalStep,
            approverEmployeeId,
            approverUserId: resolvedApproverUserId ?? null,
          },
        },
        tx as any,
      );

      result = updatedRequest;
      notify = {
        requesterUserId: (request.employee as any)?.userId,
        approverUserId: resolvedApproverUserId,
        status: dto.status,
        startDate: request.startDate,
        endDate: request.endDate,
      };
    });

    // Post-commit notifications (best-effort; the approval is the source of
    // truth and must not be rolled back by a notification failure).
    if (notify) {
      const when = `${notify.startDate.toISOString().slice(0, 10)} – ${notify.endDate
        .toISOString()
        .slice(0, 10)}`;
      try {
        if (notify.requesterUserId) {
          await this.notifications.createNotification(
            notify.requesterUserId,
            `Leave request ${notify.status === LeaveStatus.APPROVED ? 'approved' : 'rejected'}`,
            `Your leave request for ${when} was ${notify.status.toLowerCase()}.`,
            `/leave-requests/${requestId}`,
          );
        }
        if (notify.approverUserId && notify.approverUserId !== notify.requesterUserId) {
          await this.notifications.createNotification(
            notify.approverUserId,
            `Leave ${notify.status === LeaveStatus.APPROVED ? 'approved' : 'rejected'}`,
            `You ${notify.status === LeaveStatus.APPROVED ? 'approved' : 'rejected'} a leave request for ${when}.`,
            `/leave-requests/${requestId}`,
          );
        }
      } catch (error) {
        this.logger.warn(`Leave notification failed (non-blocking): ${(error as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Cancel a leave request. PENDING requests can be cancelled by their owner;
   * APPROVED requests (Phase 2, item 6) can additionally be cancelled by the
   * owner, the owner's line manager, or HR — used days are restored.
   */
  async cancelLeave(
    requestId: string,
    employeeId: string,
    opts: { userId?: string; roles?: string[] } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Row lock on the leave request so concurrent cancels serialize
      if (typeof (tx as any).$executeRaw === 'function') {
        try {
          await (tx as any).$executeRaw`SELECT 1 FROM "leave_requests" WHERE id = ${requestId} FOR UPDATE`;
        } catch {
          // Graceful fallback for mock/in-memory test environments
        }
      }

      const req = await tx.leaveRequest.findUnique({
        where: { id: requestId },
        include: { employee: { select: { managerId: true } } },
      });
      if (!req) throw new NotFoundException('Leave request not found');

      const isOwner = req.employeeId === employeeId;
      const roles = opts.roles ?? [];
      const hr = isHrOrAdmin(roles);
      const isManagerOfOwner =
        roles.includes(SystemRole.MANAGER) && (req.employee as any)?.managerId === employeeId;

      if (req.status === (LeaveStatus.PENDING as any)) {
        if (!isOwner) {
          throw new ForbiddenException('Cannot cancel another employee leave request');
        }
      } else if (req.status === (LeaveStatus.APPROVED as any)) {
        if (!isOwner && !isManagerOfOwner && !hr) {
          throw new ForbiddenException(
            'Only the request owner, their line manager, or HR can cancel approved leave',
          );
        }
      } else {
        throw new BadRequestException(
          `Only pending or approved leave requests can be cancelled (current: ${req.status})`,
        );
      }

      const holidays = await tx.holiday.findMany({
        where: { date: { gte: startOfDay(req.startDate), lte: startOfDay(req.endDate) } },
        select: { date: true },
      });
      const holidayDates = holidays.map((h) => h.date);
      const days = this.countRequestDays(req as any, holidayDates);
      const segments = (req as any).halfDay
        ? [{ year: req.startDate.getUTCFullYear(), days }]
        : workingDaysPerYear(req.startDate, req.endDate, holidayDates);

      for (const seg of segments) {
        const balance = await tx.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: req.employeeId,
              leaveTypeId: req.leaveTypeId,
              year: seg.year,
            },
          },
        });
        if (!balance) continue;
        if (req.status === (LeaveStatus.PENDING as any)) {
          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: {
              pendingDays: { decrement: seg.days },
              remainingDays: { increment: seg.days },
            },
          });
        } else {
          // Approved -> cancelled: restore used days.
          await tx.leaveBalance.update({
            where: { id: balance.id },
            data: {
              usedDays: { decrement: seg.days },
              remainingDays: { increment: seg.days },
            },
          });
        }
      }

      // v6 fix #1 — optimistic concurrency: match the status observed at read
      // time (PENDING or APPROVED, validated above). A concurrent approve or
      // cancel that changed the row makes this update miss (P2025) and the
      // whole transaction — including the balance moves above — rolls back,
      // so balances are restored exactly once.
      let updated: any;
      try {
        updated = await tx.leaveRequest.update({
          where: { id: requestId, status: req.status as any } as any,
          data: { status: LeaveStatus.CANCELLED as any },
        });
      } catch (e: any) {
        if (e?.code !== 'P2025') throw e;
        throw new ConflictException(
          'Leave request was already processed by another action — please refresh and try again',
        );
      }

      await this.audit.log(
        {
          actorId: opts.userId,
          action: AuditAction.UPDATE,
          entityType: 'LEAVE_REQUEST_CANCEL',
          entityId: requestId,
          beforeState: { status: req.status },
          afterState: { status: LeaveStatus.CANCELLED, restoredDays: days },
        },
        tx as any,
      );

      return updated;
    });
  }

  /**
   * Go-live Phase 2 item 5 — submit an AI-drafted leave request (DRAFT → PENDING).
   *
   * Owner only. The draft is validated as if freshly created: overlap
   * against PENDING/APPROVED ranges, working-day counting (working-week
   * pattern minus holidays), balance sufficiency per year segment, and the
   * policy's max-consecutive-days cap. Balance is reserved (pendingDays +=,
   * remainingDays -=) and an approval chain is initialised for long
   * requests — identical to createLeaveRequest, so a submitted draft is
   * indistinguishable from a directly created one. Audited.
   */
  async submitLeaveRequest(
    requestId: string,
    employeeId: string,
    actor: { userId?: string; email?: string } = {},
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const req = await tx.leaveRequest.findUnique({ where: { id: requestId } });
      if (!req) {
        throw new NotFoundException('Leave request not found');
      }
      if (req.employeeId !== employeeId) {
        throw new ForbiddenException('Only the request owner can submit a draft leave request');
      }
      if (req.status !== (LeaveStatus.DRAFT as any)) {
        throw new BadRequestException(
          `Only DRAFT leave requests can be submitted (current: ${req.status})`,
        );
      }
      if (!req.leaveTypeId) {
        throw new BadRequestException('The draft has no leave type — set one before submitting');
      }
      if (!req.reason || !req.reason.trim()) {
        throw new BadRequestException('The draft has no reason — add one before submitting');
      }

      const start = startOfDay(req.startDate);
      const end = startOfDay(req.endDate);
      if (end < start) {
        throw new BadRequestException('End date cannot be prior to start date');
      }
      if (end < startOfDay(new Date())) {
        throw new BadRequestException('Cannot submit a draft for dates in the past');
      }

      // Row lock on employee to prevent TOCTOU overlapping requests under concurrent submits
      if (typeof (tx as any).$executeRaw === 'function') {
        try {
          await (tx as any).$executeRaw`SELECT 1 FROM "employees" WHERE id = ${employeeId} FOR UPDATE`;
        } catch {
          // Graceful fallback for mock/in-memory test environments
        }
      }

      // --- Overlap detection (same rule as createLeaveRequest; exclude self).
      const overlapping = await tx.leaveRequest.findFirst({
        where: {
          employeeId,
          id: { not: requestId },
          status: { in: [LeaveStatus.PENDING as any, LeaveStatus.APPROVED as any] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { id: true, startDate: true, endDate: true, status: true },
      });
      if (overlapping) {
        throw new ConflictException(
          `Leave request overlaps with existing ${overlapping.status} request ` +
            `(${overlapping.startDate.toISOString().slice(0, 10)} – ` +
            `${overlapping.endDate.toISOString().slice(0, 10)})`,
        );
      }

      const holidays = await tx.holiday.findMany({
        where: { date: { gte: start, lte: end } },
        select: { date: true },
      });
      const holidayDates = holidays.map((h) => h.date);
      const policy = await this.getLeavePolicy(tx, req.leaveTypeId);
      const workingDays: number[] | undefined = policy?.workingDays ?? undefined;

      let totalDays: number;
      let segments: Array<{ year: number; days: number }>;
      if ((req as any).halfDay === true) {
        const wd = workingDaysPerYear(start, end, holidayDates, workingDays);
        if (wd.length === 0 || wd[0].days === 0) {
          throw new BadRequestException('Half-day leave must fall on a working day');
        }
        totalDays = 0.5;
        segments = [{ year: start.getUTCFullYear(), days: 0.5 }];
      } else {
        segments = workingDaysPerYear(start, end, holidayDates, workingDays);
        totalDays = segments.reduce((sum, s) => sum + s.days, 0);
      }

      if (totalDays <= 0) {
        throw new BadRequestException(
          'The requested range contains no working days (weekends/holidays only)',
        );
      }

      if (policy?.maxConsecutiveDays != null && totalDays > Number(policy.maxConsecutiveDays)) {
        throw new BadRequestException(
          `Leave request exceeds the policy maximum of ${policy.maxConsecutiveDays} consecutive days`,
        );
      }

      // --- Reserve from each year's balance (cross-year split).
      for (const seg of segments) {
        const balance = await this.ensureBalance(tx, employeeId, req.leaveTypeId, seg.year);
        if (Number(balance.remainingDays) < seg.days) {
          throw new BadRequestException(
            `Insufficient leave balance for ${seg.year}. Requested: ${seg.days} days, ` +
              `Remaining: ${balance.remainingDays} days`,
          );
        }
        await tx.leaveBalance.update({
          where: { id: balance.id },
          data: {
            pendingDays: { increment: seg.days },
            remainingDays: { decrement: seg.days },
          },
        });
      }

      const chain = buildApprovalChain(totalDays);
      const chainData =
        chain.length > 1
          ? await pickKnownColumns(
              tx,
              'leave_requests',
              { approvalChain: chain, currentStep: 0 },
              'LeavesService.submitLeaveRequest',
            )
          : {};

      let result: any;
      try {
        result = await tx.leaveRequest.update({
          where: { id: requestId, status: LeaveStatus.DRAFT as any } as any,
          data: {
            status: LeaveStatus.PENDING as any,
            totalDays,
            ...chainData,
          } as any,
          include: {
            leaveType: { select: { id: true, name: true, code: true } },
          },
        });
      } catch (e: any) {
        if (e?.code !== 'P2025') throw e;
        throw new ConflictException(
          'Leave request was already submitted or processed — please refresh and try again',
        );
      }

      await this.audit.log(
        {
          actorId: actor.userId,
          actorEmail: actor.email,
          action: AuditAction.UPDATE,
          entityType: 'LEAVE_REQUEST_SUBMIT',
          entityId: requestId,
          beforeState: { status: LeaveStatus.DRAFT },
          afterState: { status: LeaveStatus.PENDING, totalDays },
        },
        tx as any,
      );

      return { ...result, totalDays: Number(result.totalDays) };
    });

    // Post-commit: notify the requester's line manager (best-effort).
    try {
      const requester = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { manager: { select: { userId: true } } },
      });
      const managerUserId = (requester as any)?.manager?.userId;
      if (managerUserId) {
        const when =
          `${(updated as any).startDate.toISOString().slice(0, 10)} – ` +
          `${(updated as any).endDate.toISOString().slice(0, 10)}`;
        await this.notifications.createNotification(
          managerUserId,
          'New leave request',
          `A drafted leave request was submitted for ${when}.`,
          `/leave-requests/${(updated as any).id}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Leave-submit manager notification failed (non-blocking): ${(error as Error).message}`,
      );
    }

    return updated;
  }

  /** Lazily creates a balance row for (employee, leaveType, year). */
  private async ensureBalance(tx: any, employeeId: string, leaveTypeId: string, year: number) {
    let balance = await tx.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });
    if (!balance) {
      const lt = await tx.leaveType.findUnique({ where: { id: leaveTypeId } });
      if (!lt) throw new NotFoundException('Leave type not found');
      balance = await tx.leaveBalance.create({
        data: {
          employeeId,
          leaveTypeId,
          year,
          allocatedDays: lt.defaultDaysPerYear,
          remainingDays: lt.defaultDaysPerYear,
          usedDays: 0,
          pendingDays: 0,
        },
      });
    }
    return balance;
  }

  // ---------------------------------------------------------------------------
  // Holidays
  // ---------------------------------------------------------------------------

  async getHolidays() {
    return this.prisma.holiday.findMany({
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(dto: CreateHolidayDto) {
    const holidayDate = startOfDay(new Date(dto.date));
    return this.prisma.holiday.upsert({
      where: { date: holidayDate },
      update: { title: dto.title, description: dto.description },
      create: {
        title: dto.title,
        date: holidayDate,
        isRecurring: dto.isRecurring ?? false,
        description: dto.description,
      },
    });
  }
}
