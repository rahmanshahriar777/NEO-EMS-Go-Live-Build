import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  ACCESS_POLICY,
  IAccessPolicy,
  AccessViewer,
} from './access-policy';

/**
 * Role-aware dashboard KPIs (Phase 2 item 1).
 *
 * Scope resolution (via the access-policy interface; worker 2 owns the real
 * implementation — see access-policy.ts):
 *  - company: HR_ADMIN / SUPER_ADMIN / AUDITOR — full KPIs.
 *  - team: MANAGER with a linked employee profile — their direct reports.
 *  - self: everyone else with an employee profile — own data only.
 *
 * Sensitive aggregates (headcount, payroll cost) are returned ONLY at company
 * scope; team/self callers get `null` for those fields rather than a partial
 * number that could mislead.
 *
 * Timezone assumption: "today" is computed in UTC. Per-employee timezone
 * attendance boundaries are Phase 2 item 5 (attendance v2, worker 5).
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ACCESS_POLICY) private readonly accessPolicy: IAccessPolicy,
  ) {}

  private toViewer(user: { sub: string; employeeId?: string; roles: string[] }): AccessViewer {
    return { userId: user.sub, employeeId: user.employeeId, roles: user.roles ?? [] };
  }

  async getKpis(user: { sub: string; employeeId?: string; roles: string[] }) {
    const viewer = this.toViewer(user);
    const company = await this.accessPolicy.can(viewer, null, 'dashboard:company');
    const team = company
      ? false
      : await this.accessPolicy.can(viewer, null, 'dashboard:team');
    const scope = company ? 'company' : team ? 'team' : 'self';

    // Employee filter for team/self scopes. `undefined` = no filter (company).
    let employeeFilter: { id?: string; managerId?: string } | undefined;
    if (scope === 'team' && viewer.employeeId) {
      employeeFilter = { managerId: viewer.employeeId };
    } else if (scope === 'self' && viewer.employeeId) {
      employeeFilter = { id: viewer.employeeId };
    }

    const [headcount, attendance, pendingApprovals, leaveBalances, payrollCost] =
      await Promise.all([
        scope === 'company' ? this.headcountKpi() : Promise.resolve(null),
        this.attendanceKpi(employeeFilter),
        this.pendingApprovalsKpi(scope, viewer),
        this.leaveBalancesKpi(viewer),
        scope === 'company' ? this.payrollCostKpi() : Promise.resolve(null),
      ]);

    return {
      scope,
      generatedAt: new Date().toISOString(),
      headcount,
      attendanceToday: attendance,
      pendingApprovals,
      leaveBalances,
      payrollCost,
    };
  }

  private async headcountKpi() {
    const [total, byStatus] = await Promise.all([
      this.prisma.employee.count({ where: { deletedAt: null } }),
      this.prisma.employee.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { status: true },
      }),
    ]);
    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count.status])),
    };
  }

  private async attendanceKpi(employeeFilter?: { id?: string; managerId?: string }) {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const where: any = {
      date: { gte: startOfDay, lt: endOfDay },
      ...(employeeFilter ? { employee: employeeFilter } : {}),
    };

    const groups = await this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      byStatus[g.status] = g._count.status;
      total += g._count.status;
    }

    return {
      date: startOfDay.toISOString().slice(0, 10),
      total,
      present: byStatus['PRESENT'] ?? 0,
      late: byStatus['LATE'] ?? 0,
      halfDay: byStatus['HALF_DAY'] ?? 0,
      absent: byStatus['ABSENT'] ?? 0,
      onLeave: byStatus['ON_LEAVE'] ?? 0,
    };
  }

  private async pendingApprovalsKpi(scope: string, viewer: AccessViewer) {
    if (scope === 'company') {
      const leaveRequests = await this.prisma.leaveRequest.count({
        where: { status: 'PENDING' as any },
      });
      return { leaveRequests, total: leaveRequests };
    }
    if (scope === 'team' && viewer.employeeId) {
      const leaveRequests = await this.prisma.leaveRequest.count({
        where: {
          status: 'PENDING' as any,
          employee: { managerId: viewer.employeeId },
        },
      });
      return { leaveRequests, total: leaveRequests };
    }
    // self: the caller's own pending requests.
    const leaveRequests = viewer.employeeId
      ? await this.prisma.leaveRequest.count({
          where: { status: 'PENDING' as any, employeeId: viewer.employeeId },
        })
      : 0;
    return { leaveRequests, total: leaveRequests };
  }

  private async leaveBalancesKpi(viewer: AccessViewer) {
    if (!viewer.employeeId) return [];
    const year = new Date().getUTCFullYear();
    const balances = await this.prisma.leaveBalance.findMany({
      where: { employeeId: viewer.employeeId, year },
      include: { leaveType: { select: { name: true, code: true } } },
    });
    return balances.map((b) => ({
      leaveType: b.leaveType.name,
      code: b.leaveType.code,
      allocated: Number(b.allocatedDays),
      used: Number(b.usedDays),
      pending: Number(b.pendingDays),
      remaining: Number(b.remainingDays),
    }));
  }

  private async payrollCostKpi() {
    const latest = await this.prisma.payrollRun.findFirst({
      where: { status: { not: 'CANCELLED' as any } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: { _count: { select: { payslips: true } } },
    });
    if (!latest) return null;
    return {
      month: latest.month,
      year: latest.year,
      status: latest.status,
      totalGross: Number(latest.totalGross),
      totalDeductions: Number(latest.totalDeductions),
      totalNet: Number(latest.totalNet),
      payslipCount: latest._count.payslips,
    };
  }
}
