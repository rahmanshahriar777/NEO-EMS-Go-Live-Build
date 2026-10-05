import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AuditAction, JwtPayload, SystemRole } from '@ems/shared';
import {
  CreateRosterEntryDto,
  RosterQueryDto,
  UpdateRosterEntryDto,
} from './dto/rostering.dto';

// ---------------------------------------------------------------------------
// Overtime rule (ASSUMPTION — needs HR/legal sign-off before payroll use):
//   - Daily: a single roster entry longer than 8h (480 min) is overtime;
//     overtimeMinutes = minutes beyond 480.
//   - Weekly: an employee's total rostered minutes in a Monday–Sunday week
//     beyond 40h (2400 min) is overtime.
// `overtime` is true when EITHER threshold is breached. Weekly totals count
// rostered (planned) time, not clocked attendance, and ignore public
// holidays — holiday-aware overtime is a follow-up.
// ---------------------------------------------------------------------------
export const DAILY_OVERTIME_THRESHOLD_MINUTES = 8 * 60;
export const WEEKLY_OVERTIME_THRESHOLD_MINUTES = 40 * 60;

export interface OvertimeInfo {
  /** Planned hours for this entry, 2dp. */
  hoursWorked: number;
  /** Minutes beyond the 8h daily threshold (0 when within). */
  overtimeMinutes: number;
  /** True when the entry breaches the daily threshold OR the employee's week total breaches 40h. */
  overtime: boolean;
}

/** Monday 00:00:00.000 -> Sunday 23:59:59.999 (UTC) containing `date`. */
export function weekRangeMonday(date: Date): { weekStart: Date; weekEnd: Date } {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diffToMonday = (day.getUTCDay() + 6) % 7;
  const weekStart = new Date(day);
  weekStart.setUTCDate(day.getUTCDate() - diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);
  return { weekStart, weekEnd };
}

/**
 * Pure overtime math — exported for unit tests.
 * @param weekMinutesTotal the employee's total rostered minutes in the entry's Monday–Sunday week (including this entry)
 */
export function computeOvertime(
  startTime: Date,
  endTime: Date,
  weekMinutesTotal: number,
): OvertimeInfo {
  const minutes = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60000));
  const overtimeMinutes = Math.max(0, minutes - DAILY_OVERTIME_THRESHOLD_MINUTES);
  const overtime =
    overtimeMinutes > 0 || weekMinutesTotal > WEEKLY_OVERTIME_THRESHOLD_MINUTES;
  return {
    hoursWorked: Math.round((minutes / 60) * 100) / 100,
    overtimeMinutes,
    overtime,
  };
}

type RosterEntryWithEmployee = {
  id: string;
  employeeId: string;
  date: Date;
  shiftName: string | null;
  startTime: Date;
  endTime: Date;
  notes: string | null;
  createdById: string;
  createdAt: Date;
  employee: { id: string; firstName: string; lastName: string; employeeNumber: string };
};

@Injectable()
export class RosteringService {
  private readonly logger = new Logger(RosteringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private isHr(roles: SystemRole[]): boolean {
    return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
  }

  private validateTimes(startTime: Date, endTime: Date): void {
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      throw new BadRequestException('startTime and endTime must be valid datetimes.');
    }
    if (endTime <= startTime) {
      throw new BadRequestException(
        'endTime must be after startTime. For overnight shifts, set endTime on the following day.',
      );
    }
  }

  private async assertEmployeeExists(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId },
      select: { id: true, deletedAt: true },
    });
    if (!employee) {
      throw new NotFoundException(`Employee #${employeeId} not found`);
    }
    if (employee.deletedAt) {
      throw new BadRequestException('Cannot roster a deleted/inactive employee.');
    }
  }

  private async directReportIds(managerEmployeeId: string): Promise<string[]> {
    const reports = await this.prisma.employee.findMany({
      where: { managerId: managerEmployeeId, deletedAt: null },
      select: { id: true },
    });
    return reports.map((r) => r.id);
  }

  /**
   * Read scoping mirrors the employees module: HR/admin see everyone,
   * managers see themselves + direct reports, everyone else sees only
   * themselves. An explicit employeeId filter outside the viewer's scope is
   * rejected rather than silently narrowed.
   */
  private async scopedEmployeeIds(
    viewer: JwtPayload,
    requestedEmployeeId?: string,
  ): Promise<string[] | null> {
    let allowed: string[] | null; // null = unrestricted (HR/admin)
    if (this.isHr(viewer.roles)) {
      allowed = null;
    } else if (viewer.employeeId && viewer.roles.includes(SystemRole.MANAGER)) {
      allowed = [viewer.employeeId, ...(await this.directReportIds(viewer.employeeId))];
    } else if (viewer.employeeId) {
      allowed = [viewer.employeeId];
    } else {
      throw new ForbiddenException('No employee profile linked to this account.');
    }

    if (requestedEmployeeId) {
      if (allowed !== null && !allowed.includes(requestedEmployeeId)) {
        throw new ForbiddenException('You may only view roster entries for your permitted employees.');
      }
      return [requestedEmployeeId];
    }
    return allowed;
  }

  private async weekMinutes(employeeId: string, date: Date): Promise<number> {
    const { weekStart, weekEnd } = weekRangeMonday(date);
    const entries = await this.prisma.rosterEntry.findMany({
      where: { employeeId, date: { gte: weekStart, lte: weekEnd } },
      select: { startTime: true, endTime: true },
    });
    return entries.reduce(
      (sum, e) => sum + Math.max(0, Math.round((e.endTime.getTime() - e.startTime.getTime()) / 60000)),
      0,
    );
  }

  /** Batch weekly totals per (employeeId, weekStart) so list responses don't N+1. */
  private async withOvertime(
    entries: RosterEntryWithEmployee[],
  ): Promise<Array<RosterEntryWithEmployee & OvertimeInfo>> {
    const weekKeys = new Map<string, { employeeId: string; weekStart: Date }>();
    for (const e of entries) {
      const { weekStart } = weekRangeMonday(e.date);
      weekKeys.set(`${e.employeeId}:${weekStart.toISOString()}`, {
        employeeId: e.employeeId,
        weekStart,
      });
    }
    const totals = new Map<string, number>();
    await Promise.all(
      [...weekKeys.entries()].map(async ([key, { employeeId, weekStart }]) => {
        const weekEnd = new Date(weekStart);
        weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
        weekEnd.setUTCHours(23, 59, 59, 999);
        const weekEntries = await this.prisma.rosterEntry.findMany({
          where: { employeeId, date: { gte: weekStart, lte: weekEnd } },
          select: { startTime: true, endTime: true },
        });
        totals.set(
          key,
          weekEntries.reduce(
            (sum, w) =>
              sum + Math.max(0, Math.round((w.endTime.getTime() - w.startTime.getTime()) / 60000)),
            0,
          ),
        );
      }),
    );

    return entries.map((e) => {
      const { weekStart } = weekRangeMonday(e.date);
      const weekTotal = totals.get(`${e.employeeId}:${weekStart.toISOString()}`) ?? 0;
      return { ...e, ...computeOvertime(e.startTime, e.endTime, weekTotal) };
    });
  }

  private readonly entryInclude = {
    employee: {
      select: { id: true, firstName: true, lastName: true, employeeNumber: true },
    },
  } as const;

  async create(dto: CreateRosterEntryDto, actor: JwtPayload) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    this.validateTimes(startTime, endTime);
    await this.assertEmployeeExists(dto.employeeId);

    const entry = await this.prisma.rosterEntry.create({
      data: {
        employeeId: dto.employeeId,
        date: new Date(dto.date),
        shiftName: dto.shiftName ?? null,
        startTime,
        endTime,
        notes: dto.notes ?? null,
        createdById: actor.sub,
      },
      include: this.entryInclude,
    });

    await this.auditService.log({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: AuditAction.CREATE,
      entityType: 'RosterEntry',
      entityId: entry.id,
      afterState: { employeeId: entry.employeeId, date: entry.date },
    });

    const weekTotal = await this.weekMinutes(entry.employeeId, entry.date);
    return { ...entry, ...computeOvertime(entry.startTime, entry.endTime, weekTotal) };
  }

  async findAllScoped(query: RosterQueryDto, viewer: JwtPayload) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const allowedIds = await this.scopedEmployeeIds(viewer, query.employeeId);

    const where: Record<string, unknown> = {};
    if (allowedIds !== null) where.employeeId = { in: allowedIds };
    if (query.from || query.to) {
      where.date = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const [total, items] = await this.prisma.$transaction([
      this.prisma.rosterEntry.count({ where }),
      this.prisma.rosterEntry.findMany({
        where,
        include: this.entryInclude,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const data = await this.withOvertime(items as RosterEntryWithEmployee[]);
    return { data, meta: { page, limit, total } };
  }

  async findOneScoped(id: string, viewer: JwtPayload) {
    const entry = await this.prisma.rosterEntry.findUnique({
      where: { id },
      include: this.entryInclude,
    });
    if (!entry) throw new NotFoundException(`Roster entry #${id} not found`);

    const allowedIds = await this.scopedEmployeeIds(viewer);
    if (allowedIds !== null && !allowedIds.includes(entry.employeeId)) {
      throw new ForbiddenException('You may not view this roster entry.');
    }

    const weekTotal = await this.weekMinutes(entry.employeeId, entry.date);
    return { ...entry, ...computeOvertime(entry.startTime, entry.endTime, weekTotal) };
  }

  async update(id: string, dto: UpdateRosterEntryDto, actor: JwtPayload) {
    const existing = await this.prisma.rosterEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Roster entry #${id} not found`);

    if (dto.employeeId && dto.employeeId !== existing.employeeId) {
      await this.assertEmployeeExists(dto.employeeId);
    }
    const startTime = dto.startTime ? new Date(dto.startTime) : existing.startTime;
    const endTime = dto.endTime ? new Date(dto.endTime) : existing.endTime;
    if (dto.startTime || dto.endTime) this.validateTimes(startTime, endTime);

    const entry = await this.prisma.rosterEntry.update({
      where: { id },
      data: {
        ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
        ...(dto.date ? { date: new Date(dto.date) } : {}),
        ...(dto.shiftName !== undefined ? { shiftName: dto.shiftName } : {}),
        ...(dto.startTime ? { startTime } : {}),
        ...(dto.endTime ? { endTime } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      include: this.entryInclude,
    });

    await this.auditService.log({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: AuditAction.UPDATE,
      entityType: 'RosterEntry',
      entityId: entry.id,
      afterState: { employeeId: entry.employeeId, date: entry.date },
    });

    const weekTotal = await this.weekMinutes(entry.employeeId, entry.date);
    return { ...entry, ...computeOvertime(entry.startTime, entry.endTime, weekTotal) };
  }

  async remove(id: string, actor: JwtPayload) {
    const existing = await this.prisma.rosterEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Roster entry #${id} not found`);

    // Roster entries are operational plans, not statutory records, so hard
    // delete is acceptable (unlike payroll/attendance, which are Restrict).
    await this.prisma.rosterEntry.delete({ where: { id } });

    await this.auditService.log({
      actorId: actor.sub,
      actorEmail: actor.email,
      action: AuditAction.DELETE,
      entityType: 'RosterEntry',
      entityId: id,
      beforeState: { employeeId: existing.employeeId, date: existing.date },
    });

    return { deleted: true, id };
  }
}
