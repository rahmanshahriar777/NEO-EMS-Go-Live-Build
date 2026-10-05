import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { RedisService } from '../../core/redis/redis.service';
import { AuditAction, SystemRole } from '@ems/shared';

/**
 * Attendance correction requests (Phase 2 item 5 — correction requests +
 * manager approval).
 *
 * INTERIM STORE: there is no AttendanceCorrection table yet (schema worker —
 * reported as a follow-up need), so requests live in Redis under
 * `attendance:correction:<id>` with an id index at
 * `attendance:corrections:index`. All persistence goes through this service
 * so swapping to a Prisma model later is a one-file change.
 *
 * Works WITHOUT breakMinutes/overtimeHours columns (not in worker 4's
 * migration): corrections adjust clockInTime/clockOutTime only, and
 * totalHoursWorked is recomputed from the corrected times.
 *
 * Workflow: employee requests → line manager or HR approves/rejects →
 * on APPROVED the AttendanceRecord is updated in the same flow.
 */
export type AttendanceCorrectionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AttendanceCorrection {
  id: string;
  attendanceRecordId: string;
  employeeId: string;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
}

export interface CreateCorrectionInput {
  attendanceRecordId: string;
  requestedClockIn?: string;
  requestedClockOut?: string;
  reason: string;
}

export interface CorrectionDecider {
  userId: string;
  employeeId?: string;
  roles: string[];
}

const KEY_PREFIX = 'attendance:correction:';
const INDEX_KEY = 'attendance:corrections:index';

@Injectable()
export class AttendanceCorrectionsService {
  private readonly logger = new Logger(AttendanceCorrectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  private async readIndex(): Promise<string[]> {
    const raw = await this.redis.get(INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.redis.set(INDEX_KEY, JSON.stringify(ids));
  }

  private async load(id: string): Promise<AttendanceCorrection | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AttendanceCorrection;
    } catch {
      return null;
    }
  }

  private async save(correction: AttendanceCorrection): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${correction.id}`, JSON.stringify(correction));
  }

  async create(employeeId: string, input: CreateCorrectionInput): Promise<AttendanceCorrection> {
    if (!input.requestedClockIn && !input.requestedClockOut) {
      throw new BadRequestException(
        'At least one of requestedClockIn / requestedClockOut is required',
      );
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('A reason is required for a correction request');
    }

    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: input.attendanceRecordId },
      select: { id: true, employeeId: true },
    });
    if (!record) throw new NotFoundException('Attendance record not found');
    if (record.employeeId !== employeeId) {
      throw new ForbiddenException('Cannot request corrections for another employee’s attendance');
    }

    // One pending request per record at a time.
    const ids = await this.readIndex();
    for (const id of ids) {
      const existing = await this.load(id);
      if (
        existing &&
        existing.attendanceRecordId === input.attendanceRecordId &&
        existing.status === 'PENDING'
      ) {
        throw new ConflictException('A pending correction request already exists for this record');
      }
    }

    const correction: AttendanceCorrection = {
      id: randomUUID(),
      attendanceRecordId: input.attendanceRecordId,
      employeeId,
      requestedClockIn: input.requestedClockIn ?? null,
      requestedClockOut: input.requestedClockOut ?? null,
      reason: input.reason.trim(),
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      decidedAt: null,
      decidedByUserId: null,
    };
    await this.save(correction);
    await this.writeIndex([...ids, correction.id]);

    await this.audit.log({
      action: AuditAction.CREATE,
      entityType: 'ATTENDANCE_CORRECTION',
      entityId: correction.id,
      afterState: { ...correction },
    });

    return correction;
  }

  /**
   * Lists corrections visible to the viewer: HR/admin see all, managers see
   * their reports', employees see their own. Optional status filter.
   */
  async list(
    viewer: CorrectionDecider,
    status?: AttendanceCorrectionStatus,
  ): Promise<AttendanceCorrection[]> {
    const ids = await this.readIndex();
    const all: AttendanceCorrection[] = [];
    for (const id of ids) {
      const c = await this.load(id);
      if (c) all.push(c);
    }

    const isHr =
      viewer.roles.includes(SystemRole.HR_ADMIN) || viewer.roles.includes(SystemRole.SUPER_ADMIN);
    let visible = all;
    if (!isHr) {
      if (!viewer.employeeId) return [];
      const isManager = viewer.roles.includes(SystemRole.MANAGER);
      if (isManager) {
        // Reports of this manager (plus their own).
        const reports = await this.prisma.employee.findMany({
          where: { managerId: viewer.employeeId, deletedAt: null },
          select: { id: true },
        });
        const allowed = new Set([viewer.employeeId, ...reports.map(r => r.id)]);
        visible = all.filter(c => allowed.has(c.employeeId));
      } else {
        visible = all.filter(c => c.employeeId === viewer.employeeId);
      }
    }

    const filtered = status ? visible.filter(c => c.status === status) : visible;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Approves/rejects a PENDING correction. The decider must be the
   * employee's line manager or HR/admin (mirrors leave approval A2).
   * On APPROVED the attendance record's times are updated and
   * totalHoursWorked recomputed from the corrected times.
   */
  async decide(
    id: string,
    status: 'APPROVED' | 'REJECTED',
    decider: CorrectionDecider,
  ): Promise<AttendanceCorrection> {
    const correction = await this.load(id);
    if (!correction) throw new NotFoundException('Correction request not found');
    if (correction.status !== 'PENDING') {
      throw new BadRequestException(`Correction request is already ${correction.status}`);
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: correction.employeeId },
      select: { id: true, managerId: true },
    });
    const isHr =
      decider.roles.includes(SystemRole.HR_ADMIN) || decider.roles.includes(SystemRole.SUPER_ADMIN);
    const isManager = !!decider.employeeId && employee?.managerId === decider.employeeId;
    if (!isHr && !isManager) {
      throw new ForbiddenException('Only the employee’s line manager or HR can decide corrections');
    }
    if (employee && decider.employeeId === employee.id) {
      throw new ForbiddenException('You cannot decide your own correction request');
    }

    correction.status = status;
    correction.decidedAt = new Date().toISOString();
    correction.decidedByUserId = decider.userId;

    if (status === 'APPROVED') {
      await this.applyCorrection(correction);
    }

    await this.save(correction);

    await this.audit.log({
      actorId: decider.userId,
      action: status === 'APPROVED' ? AuditAction.APPROVE : AuditAction.REJECT,
      entityType: 'ATTENDANCE_CORRECTION',
      entityId: id,
      afterState: { ...correction },
    });

    return correction;
  }

  /**
   * Applies an approved correction to the attendance record. Only
   * clockInTime/clockOutTime are touched — breakMinutes/overtimeHours
   * columns do not exist (worker 4 migration), so overtime continues to be
   * derived from totalHoursWorked.
   */
  private async applyCorrection(correction: AttendanceCorrection): Promise<void> {
    const record = await this.prisma.attendanceRecord.findUnique({
      where: { id: correction.attendanceRecordId },
    });
    if (!record) {
      throw new NotFoundException('Attendance record for this correction no longer exists');
    }

    const clockIn = correction.requestedClockIn
      ? new Date(correction.requestedClockIn)
      : record.clockInTime;
    const clockOut = correction.requestedClockOut
      ? new Date(correction.requestedClockOut)
      : record.clockOutTime;
    if (
      (correction.requestedClockIn && Number.isNaN(clockIn!.getTime())) ||
      (correction.requestedClockOut && Number.isNaN(clockOut!.getTime()))
    ) {
      throw new BadRequestException('Requested clock times are not valid dates');
    }
    if (clockIn && clockOut && clockOut < clockIn) {
      throw new BadRequestException('Clock-out cannot be before clock-in');
    }

    const totalHoursWorked =
      clockIn && clockOut
        ? Number(((clockOut.getTime() - clockIn.getTime()) / 3600000).toFixed(2))
        : null;

    await this.prisma.attendanceRecord.update({
      where: { id: correction.attendanceRecordId },
      data: {
        ...(correction.requestedClockIn ? { clockInTime: clockIn } : {}),
        ...(correction.requestedClockOut ? { clockOutTime: clockOut } : {}),
        ...(totalHoursWorked !== null ? { totalHoursWorked } : {}),
      },
    });
  }
}
