import { Job } from 'bullmq';
import { prisma } from '@ems/database';
import { log } from '../logger.js';

/**
 * Nightly absence marking (Phase 2 item 5).
 *
 * Runs once a day via a BullMQ repeatable job (see schedule.ts). For every
 * active employee it marks ABSENT for "yesterday" (in the employee entity's
 * timezone) when none of the following exists for that date:
 *   - an attendance record (any status),
 *   - an APPROVED leave request covering the date,
 *   - a company holiday on the date.
 *
 * Assumptions (documented per repo convention):
 *   - "Yesterday" is computed in the employee's entity timezone (fallback
 *     'UTC'); the job therefore runs once per timezone group, not once per
 *     employee.
 *   - Holidays are currently global (no entity-scoped holiday calendar yet);
 *     a holiday suppresses marking for every timezone group that day.
 *   - A roster entry alone does NOT excuse absence — rostered-but-absent is
 *     still ABSENT. The roster is scheduling intent, not attendance proof.
 *   - Only non-terminated staff are considered (TERMINATED/RESIGNED excluded).
 *   - Idempotent: @@unique([employeeId, date]) + createMany(skipDuplicates),
 *     so a retried or overlapping run converges.
 */

export const AUTO_ABSENT_NOTE = 'Auto-marked ABSENT by the nightly job: no clock-in, attendance record, or approved leave for this date.';

/**
 * "Yesterday" as YYYY-MM-DD in the given IANA timezone. Pure — unit tested.
 */
export function targetDateForTimezone(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // Noon UTC avoids any DST edge when stepping back a day.
  const todayNoon = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), 12));
  todayNoon.setUTCDate(todayNoon.getUTCDate() - 1);
  return todayNoon.toISOString().slice(0, 10);
}

export interface AbsenceMarkingResult {
  groups: Array<{ timezone: string; date: string; checked: number; marked: number; skipped: number }>;
  totalChecked: number;
  totalMarked: number;
}

export async function markNightlyAbsences(job: Job<{ correlationId?: string }>): Promise<AbsenceMarkingResult> {
  const correlationId = job.data?.correlationId;
  log.info('attendance.absence.start', { jobId: job.id, correlationId });

  const employees = await prisma.employee.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ['TERMINATED', 'RESIGNED'] },
    },
    select: {
      id: true,
      entity: { select: { timezone: true } },
    },
  });

  // Group by entity timezone so "yesterday" is correct per employee.
  const byTz = new Map<string, string[]>();
  for (const emp of employees) {
    const tz = emp.entity?.timezone || 'UTC';
    const list = byTz.get(tz) ?? [];
    list.push(emp.id);
    byTz.set(tz, list);
  }

  const result: AbsenceMarkingResult = { groups: [], totalChecked: 0, totalMarked: 0 };

  for (const [timezone, employeeIds] of byTz) {
    const dateStr = targetDateForTimezone(timezone);
    const date = new Date(`${dateStr}T00:00:00Z`);

    const [existing, onLeave, holiday] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, date },
        select: { employeeId: true },
      }),
      prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: 'APPROVED',
          startDate: { lte: date },
          endDate: { gte: date },
        },
        select: { employeeId: true },
      }),
      prisma.holiday.findFirst({ where: { date }, select: { id: true } }),
    ]);

    if (holiday) {
      log.info('attendance.absence.holiday', { timezone, date: dateStr, employees: employeeIds.length });
      result.groups.push({ timezone, date: dateStr, checked: employeeIds.length, marked: 0, skipped: employeeIds.length });
      result.totalChecked += employeeIds.length;
      continue;
    }

    const excused = new Set([...existing, ...onLeave].map((r) => r.employeeId));
    const absentIds = employeeIds.filter((id) => !excused.has(id));

    if (absentIds.length > 0) {
      await prisma.attendanceRecord.createMany({
        data: absentIds.map((employeeId) => ({
          employeeId,
          date,
          status: 'ABSENT' as const,
          notes: AUTO_ABSENT_NOTE,
        })),
        skipDuplicates: true,
      });
    }

    log.info('attendance.absence.group', {
      jobId: job.id,
      timezone,
      date: dateStr,
      checked: employeeIds.length,
      marked: absentIds.length,
      correlationId,
    });
    result.groups.push({
      timezone,
      date: dateStr,
      checked: employeeIds.length,
      marked: absentIds.length,
      skipped: employeeIds.length - absentIds.length,
    });
    result.totalChecked += employeeIds.length;
    result.totalMarked += absentIds.length;
  }

  log.info('attendance.absence.done', {
    jobId: job.id,
    totalChecked: result.totalChecked,
    totalMarked: result.totalMarked,
    correlationId,
  });
  return result;
}
