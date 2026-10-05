import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { JwtPayload, SystemRole } from '@ems/shared';

/**
 * Unified calendar event (SRS FR-CAL-001).
 *
 * Shape is deliberately simple and stable for the web client:
 *   { id, type: 'leave' | 'holiday' | 'roster', title, start, end, employeeId? }
 * `start`/`end` are ISO-8601 strings; leave and holiday events are all-day
 * (end is inclusive at day granularity).
 */
export type CalendarEventType = 'leave' | 'holiday' | 'roster';

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  start: string;
  end: string;
  employeeId?: string;
}

interface LeaveVisibility {
  /** Employees whose leave the viewer may see WITH names (own + permitted others). */
  namedEmployeeIds: Set<string> | 'all';
  /** Whether the viewer may see other employees' leave anonymously ("Busy"). */
  seeAnonymousBusy: boolean;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  private isHr(roles: SystemRole[]): boolean {
    return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
  }

  private async directReportIds(managerEmployeeId: string): Promise<string[]> {
    const reports = await this.prisma.employee.findMany({
      where: { managerId: managerEmployeeId, deletedAt: null },
      select: { id: true },
    });
    return reports.map((r) => r.id);
  }

  private async leaveVisibility(viewer: JwtPayload): Promise<LeaveVisibility> {
    if (this.isHr(viewer.roles)) {
      return { namedEmployeeIds: 'all', seeAnonymousBusy: false };
    }
    const named = new Set<string>();
    if (viewer.employeeId) {
      named.add(viewer.employeeId);
      if (viewer.roles.includes(SystemRole.MANAGER)) {
        for (const id of await this.directReportIds(viewer.employeeId)) named.add(id);
      }
    }
    // Peers (and managers, for non-reports) still get anonymous busy blocks so
    // the team calendar is useful without leaking who is away or why.
    return { namedEmployeeIds: named, seeAnonymousBusy: true };
  }

  /**
   * Unified events for [from, to] (inclusive): approved leave ranges, holidays
   * and roster entries. Leave titles carry the employee name for HR/admin and
   * managers (own team); everyone else sees "Busy".
   */
  async getEvents(from: Date, to: Date, viewer: JwtPayload): Promise<CalendarEvent[]> {
    const visibility = await this.leaveVisibility(viewer);
    const events: CalendarEvent[] = [];

    // --- Approved leave requests overlapping the range ---
    const leaves = await this.prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
        leaveType: { select: { name: true } },
      },
      orderBy: { startDate: 'asc' },
      take: 1000,
    });

    for (const leave of leaves) {
      const named =
        visibility.namedEmployeeIds === 'all' ||
        visibility.namedEmployeeIds.has(leave.employeeId);
      if (!named && !visibility.seeAnonymousBusy) continue;
      events.push({
        id: `leave:${leave.id}`,
        type: 'leave',
        title: named
          ? `${leave.employee.firstName} ${leave.employee.lastName} — ${leave.leaveType.name} leave`
          : 'Busy',
        start: leave.startDate.toISOString(),
        end: leave.endDate.toISOString(),
        ...(named ? { employeeId: leave.employeeId } : {}),
      });
    }

    // --- Holidays in range ---
    const holidays = await this.prisma.holiday.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
    for (const h of holidays) {
      events.push({
        id: `holiday:${h.id}`,
        type: 'holiday',
        title: h.title,
        start: h.date.toISOString(),
        end: h.date.toISOString(),
      });
    }

    // --- Roster entries in range (same visibility as the employees module:
    // HR all, manager own + direct reports, everyone else self) ---
    const rosterWhere = await this.rosterVisibilityWhere(viewer);
    const rosterEntries = await this.prisma.rosterEntry.findMany({
      where: { ...rosterWhere, date: { gte: from, lte: to } },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 2000,
    });
    for (const entry of rosterEntries) {
      const showName = this.isHr(viewer.roles) || entry.employeeId === viewer.employeeId;
      events.push({
        id: `roster:${entry.id}`,
        type: 'roster',
        title: showName
          ? `${entry.employee.firstName} ${entry.employee.lastName} — ${entry.shiftName ?? 'Shift'}`
          : (entry.shiftName ?? 'Shift'),
        start: entry.startTime.toISOString(),
        end: entry.endTime.toISOString(),
        employeeId: entry.employeeId,
      });
    }

    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }

  private async rosterVisibilityWhere(viewer: JwtPayload): Promise<Record<string, unknown>> {
    if (this.isHr(viewer.roles)) return {};
    if (viewer.employeeId && viewer.roles.includes(SystemRole.MANAGER)) {
      const reports = await this.directReportIds(viewer.employeeId);
      return { employeeId: { in: [viewer.employeeId, ...reports] } };
    }
    return { employeeId: viewer.employeeId ?? '__none__' };
  }

  /**
   * Holiday list for a calendar year, ascending by date.
   *
   * ASSUMPTION: only Holiday rows whose `date` falls inside the year are
   * returned. Recurring statutory holidays are NOT auto-projected — a
   * recurring holiday must be materialised as a row for the target year
   * (by the seed or an admin via POST /leaves/holidays) to appear here.
   */
  async getHolidays(year: number) {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    return this.prisma.holiday.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    });
  }
}
