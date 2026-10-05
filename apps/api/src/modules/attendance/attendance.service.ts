import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { pickKnownColumns, hasColumn, tableExists } from '../../core/prisma/schema-compat.util';
import {
  ClockInDto,
  ClockOutDto,
  AttendanceQueryDto,
  RequestCorrectionDto,
  ReviewCorrectionDto,
} from './dto/attendance.dto';
import {
  normalizeTimezone,
  zonedToday,
  zonedTimeToUtc,
  computeBreakAndOvertime,
  DEFAULT_TIMEZONE,
} from './timezone.util';
import { AttendanceStatus, AuditAction, DateUtil, createPaginatedResponse, SystemRole } from '@ems/shared';

export interface AttendanceViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

/**
 * Schema need (worker 4) — new model AttendanceCorrection:
 *   id String @id @default(uuid()); attendanceRecordId String;
 *   employeeId String; requestedClockIn DateTime?; requestedClockOut DateTime?;
 *   reason String; status CorrectionStatus @default(PENDING);
 *   reviewedById String?; reviewedAt DateTime?; createdAt DateTime @default(now());
 *   @@index([employeeId, status]); @@map("attendance_corrections")
 * plus AttendanceRecord.breakMinutes Int? and AttendanceRecord.overtimeMinutes Int?.
 */

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  /**
   * Resolves the employee's IANA timezone (Employee.timezone, via worker 4
   * migration). Falls back to UTC while unmigrated — never fails.
   */
  private async getEmployeeTimezone(client: any, employeeId: string): Promise<string> {
    try {
      if (!(await hasColumn(client, 'employees', 'timezone'))) return DEFAULT_TIMEZONE;
      const rows: Array<{ timezone: string | null }> = await client.$queryRaw`
        SELECT "timezone" FROM employees WHERE id = ${employeeId}
      `;
      return normalizeTimezone(rows[0]?.timezone);
    } catch (error) {
      this.logger.warn(`Timezone lookup failed for ${employeeId}: ${(error as Error).message}`);
      return DEFAULT_TIMEZONE;
    }
  }

  /**
   * Today's roster shift for the employee, if rostered. RosterEntry times are
   * absolute instants; the entry is matched on the employee-local date.
   */
  private async getRosterShift(client: any, employeeId: string, dateKey: Date) {
    const entry = await client.rosterEntry.findFirst({
      where: { employeeId, date: dateKey },
      select: { id: true, startTime: true, endTime: true, shiftName: true },
    });
    return entry;
  }

  async clockIn(employeeId: string, dto: ClockInDto) {
    const timezone = await this.getEmployeeTimezone(this.prisma, employeeId);
    const { dateKey, year, month, day } = zonedToday(timezone);
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: dateKey } },
    });
    if (existing && existing.clockInTime) {
      throw new BadRequestException('You have already clocked in for today');
    }

    // Shift source: today's roster entry first, then the default Shift.
    const rosterShift = await this.getRosterShift(this.prisma, employeeId, dateKey);
    const defaultShift = rosterShift
      ? null
      : await this.prisma.shift.findFirst({ where: { isDefault: true } });

    const now = new Date();
    let status = AttendanceStatus.PRESENT;

    // Late check against the shift start (+ grace) in the employee's zone.
    if (rosterShift) {
      const graceMs = 15 * 60000; // roster entries carry absolute times; 15m grace assumption
      if (now.getTime() > rosterShift.startTime.getTime() + graceMs) {
        status = AttendanceStatus.LATE;
      }
    } else if (defaultShift) {
      const shiftStartUtc = zonedTimeToUtc(dateStr, defaultShift.startTime, timezone);
      const graceMs = (defaultShift.gracePeriodMinutes ?? 0) * 60000;
      if (now.getTime() > shiftStartUtc.getTime() + graceMs) {
        status = AttendanceStatus.LATE;
      }
    }

    return this.prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId, date: dateKey } },
      update: {
        clockInTime: now,
        status: status as any,
        notes: dto.notes,
        shiftId: defaultShift?.id,
      },
      create: {
        employeeId,
        date: dateKey,
        clockInTime: now,
        status: status as any,
        notes: dto.notes,
        shiftId: defaultShift?.id,
      },
    });
  }

  async clockOut(employeeId: string, dto: ClockOutDto) {
    const timezone = await this.getEmployeeTimezone(this.prisma, employeeId);
    const { dateKey, year, month, day } = zonedToday(timezone);
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date: dateKey } },
    });

    if (!existing || !existing.clockInTime) {
      throw new BadRequestException('Cannot clock out without clocking in first');
    }
    if (existing.clockOutTime) {
      throw new BadRequestException('You have already clocked out for today');
    }

    const clockOutTime = new Date();
    const hours = DateUtil.calculateHoursWorked(existing.clockInTime, clockOutTime);

    let finalStatus = existing.status;
    if (hours < 4) {
      finalStatus = AttendanceStatus.HALF_DAY as any;
    }

    // Shift window for break/overtime: roster entry first, else default shift
    // hours interpreted in the employee's timezone.
    const rosterShift = await this.getRosterShift(this.prisma, employeeId, dateKey);
    let shiftStart: Date | null = null;
    let shiftEnd: Date | null = null;
    if (rosterShift) {
      shiftStart = rosterShift.startTime;
      shiftEnd = rosterShift.endTime;
    } else {
      const defaultShift = await this.prisma.shift.findFirst({ where: { isDefault: true } });
      if (defaultShift) {
        shiftStart = zonedTimeToUtc(dateStr, defaultShift.startTime, timezone);
        shiftEnd = zonedTimeToUtc(dateStr, defaultShift.endTime, timezone);
      }
    }

    const { breakMinutes, overtimeMinutes } = computeBreakAndOvertime(
      existing.clockInTime,
      clockOutTime,
      shiftStart,
      shiftEnd,
    );

    const timeData = await pickKnownColumns(
      this.prisma,
      'attendance_records',
      { breakMinutes, overtimeMinutes },
      'AttendanceService.clockOut',
    );

    return this.prisma.attendanceRecord.update({
      where: { id: existing.id },
      data: {
        clockOutTime,
        totalHoursWorked: hours,
        status: finalStatus,
        notes: dto.notes ? `${existing.notes || ''} | ${dto.notes}` : existing.notes,
        ...timeData,
      } as any,
    });
  }

  // ---------------------------------------------------------------------------
  // Correction requests (Phase 2, item 5): employee requests, manager/HR approves.
  // ---------------------------------------------------------------------------

  async requestCorrection(employeeId: string, dto: RequestCorrectionDto, userId?: string) {
    if (!(await tableExists(this.prisma, 'attendance_corrections'))) {
      throw new ServiceUnavailableException(
        'Attendance corrections require the AttendanceCorrection migration (worker 4).',
      );
    }

    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: dto.attendanceRecordId },
    });
    if (!record) throw new NotFoundException('Attendance record not found');
    if (record.employeeId !== employeeId) {
      throw new ForbiddenException('Cannot request a correction for another employee');
    }
    if (!dto.clockInTime && !dto.clockOutTime) {
      throw new BadRequestException('At least one of clockInTime / clockOutTime is required');
    }

    const correction = await (this.prisma as any).attendanceCorrection.create({
      data: {
        attendanceRecordId: dto.attendanceRecordId,
        employeeId,
        requestedClockIn: dto.clockInTime ? new Date(dto.clockInTime) : null,
        requestedClockOut: dto.clockOutTime ? new Date(dto.clockOutTime) : null,
        reason: dto.reason,
        status: 'PENDING',
      },
    });

    await this.audit.log({
      actorId: userId,
      action: AuditAction.UPDATE,
      entityType: 'ATTENDANCE_CORRECTION',
      entityId: correction.id,
      afterState: correction,
    });

    return correction;
  }

  async listCorrections(viewer: AttendanceViewer) {
    if (!(await tableExists(this.prisma, 'attendance_corrections'))) return [];

    const where: any = {};
    const roles = viewer.roles ?? [];
    const hr = roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
    if (hr) {
      // all
    } else if (!viewer.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    } else if (roles.includes(SystemRole.MANAGER)) {
      const reports = await this.prisma.employee.findMany({
        where: { managerId: viewer.employeeId, deletedAt: null },
        select: { id: true },
      });
      where.employeeId = { in: [viewer.employeeId, ...reports.map((r) => r.id)] };
    } else {
      where.employeeId = viewer.employeeId;
    }

    return (this.prisma as any).attendanceCorrection.findMany({
      where,
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Manager/HR review of a correction request. The reviewer must be the
   * employee's line manager or HR; approval applies the corrected times and
   * recomputes hours/break/overtime.
   */
  async reviewCorrection(
    id: string,
    reviewer: AttendanceViewer,
    dto: ReviewCorrectionDto,
  ) {
    if (!(await tableExists(this.prisma, 'attendance_corrections'))) {
      throw new ServiceUnavailableException(
        'Attendance corrections require the AttendanceCorrection migration (worker 4).',
      );
    }

    const correction = await (this.prisma as any).attendanceCorrection.findUnique({
      where: { id },
      include: { employee: { select: { id: true, managerId: true } } },
    });
    if (!correction) throw new NotFoundException('Correction request not found');
    if (correction.status !== 'PENDING') {
      throw new BadRequestException(`Correction request is already ${correction.status}`);
    }

    const roles = reviewer.roles ?? [];
    const hr = roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
    const isManagerOfOwner =
      roles.includes(SystemRole.MANAGER) && correction.employee?.managerId === reviewer.employeeId;
    if (!hr && !isManagerOfOwner) {
      throw new ForbiddenException('Only the employee\u2019s line manager or HR can review corrections');
    }

    const approved = dto.decision === 'APPROVE';

    const updated = await this.prisma.$transaction(async (tx) => {
      let applied: any = null;
      if (approved) {
        const record = await tx.attendanceRecord.findUnique({
          where: { id: correction.attendanceRecordId },
        });
        if (!record) throw new NotFoundException('Attendance record not found');

        const clockInTime = correction.requestedClockIn ?? record.clockInTime;
        const clockOutTime = correction.requestedClockOut ?? record.clockOutTime;
        const patch: any = {};
        if (correction.requestedClockIn) patch.clockInTime = new Date(correction.requestedClockIn);
        if (correction.requestedClockOut) {
          patch.clockOutTime = new Date(correction.requestedClockOut);
          patch.totalHoursWorked = DateUtil.calculateHoursWorked(clockInTime, clockOutTime);
          const { breakMinutes, overtimeMinutes } = computeBreakAndOvertime(
            new Date(clockInTime),
            new Date(clockOutTime),
          );
          Object.assign(
            patch,
            await pickKnownColumns(
              tx,
              'attendance_records',
              { breakMinutes, overtimeMinutes },
              'AttendanceService.reviewCorrection',
            ),
          );
        }
        applied = await tx.attendanceRecord.update({
          where: { id: record.id },
          data: patch,
        });
      }

      const reviewed = await (tx as any).attendanceCorrection.update({
        where: { id },
        data: {
          status: approved ? 'APPROVED' : 'REJECTED',
          reviewedById: reviewer.userId,
          reviewedAt: new Date(),
        },
      });

      await this.audit.log(
        {
          actorId: reviewer.userId,
          action: approved ? AuditAction.APPROVE : AuditAction.REJECT,
          entityType: 'ATTENDANCE_CORRECTION',
          entityId: id,
          beforeState: { status: 'PENDING' },
          afterState: { status: reviewed.status, appliedRecordId: applied?.id ?? null },
        },
        tx as any,
      );

      return reviewed;
    });

    return updated;
  }

  /**
   * Nightly absence marking (Phase 2, item 5): creates ABSENT records for
   * active employees with no attendance row and no approved leave covering
   * the date. Intended for a worker cron — reported as wiring follow-up.
   */
  async markAbsentForDate(dateStr: string): Promise<{ date: string; marked: number }> {
    const dateKey = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(dateKey.getTime())) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }

    const employees = await this.prisma.employee.findMany({
      where: { deletedAt: null, status: { not: 'TERMINATED' as any } },
      select: { id: true },
    });

    const [present, onLeave] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { date: dateKey },
        select: { employeeId: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          status: 'APPROVED' as any,
          startDate: { lte: dateKey },
          endDate: { gte: dateKey },
        },
        select: { employeeId: true },
      }),
    ]);
    const excused = new Set([...present, ...onLeave].map((r) => r.employeeId));
    const absent = employees.filter((e) => !excused.has(e.id));

    let marked = 0;
    for (const emp of absent) {
      try {
        await this.prisma.attendanceRecord.create({
          data: {
            employeeId: emp.id,
            date: dateKey,
            status: AttendanceStatus.ABSENT as any,
            anomalyFlag: true,
            notes: 'Auto-marked absent by nightly job (no clock-in, no approved leave)',
          },
        });
        marked++;
      } catch (error: any) {
        // Race with a late clock-in (unique key) — not an error.
        this.logger.warn(`Absence marking skipped for ${emp.id}: ${error.message}`);
      }
    }

    this.logger.log(`Marked ${marked} employees absent for ${dateStr}`);
    return { date: dateStr, marked };
  }

  async getMyAttendance(employeeId: string, query: AttendanceQueryDto) {
    const { page = 1, limit = 20, startDate, endDate } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      employeeId,
      ...(startDate && endDate && {
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    // Today status check — in the employee's timezone.
    const timezone = await this.getEmployeeTimezone(this.prisma, employeeId);
    const { dateKey } = zonedToday(timezone);
    const todayRecord = await this.prisma.attendanceRecord.findUnique({
      where: {
        employeeId_date: {
          employeeId,
          date: dateKey,
        },
      },
    });

    const response = createPaginatedResponse(items, total, page, limit);
    return {
      ...response,
      meta: {
        ...response.meta,
        today: todayRecord,
        timezone,
      },
    };
  }

  async getTeamAttendance(managerEmployeeId: string, query: AttendanceQueryDto) {
    const { page = 1, limit = 20, status } = query;
    const skip = (page - 1) * limit;

    const subordinates = await this.prisma.employee.findMany({
      where: { managerId: managerEmployeeId, deletedAt: null },
      select: { id: true },
    });
    const subIds = subordinates.map((s) => s.id);

    const where: any = {
      employeeId: { in: subIds },
      ...(status && { status }),
    };

    const [items, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: 'desc' },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
        },
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }

  async getReports(query: AttendanceQueryDto) {
    const { page = 1, limit = 20, departmentId, employeeId, startDate, endDate, status } = query;
    const skip = (page - 1) * limit;

    const where: any = {
      ...(employeeId && { employeeId }),
      ...(status && { status }),
      ...(departmentId && { employee: { departmentId } }),
      ...(startDate && endDate && {
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: 'desc' },
        include: {
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
              department: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }
}
