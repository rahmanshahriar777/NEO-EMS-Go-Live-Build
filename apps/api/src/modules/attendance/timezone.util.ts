/**
 * Timezone helpers (Phase 2, item 5 — attendance v2; Phase 1 "Money/time"
 * refactoring).
 *
 * Rules:
 * - All instants are stored as UTC (Date objects).
 * - "Today" and shift boundaries are computed in the EMPLOYEE's timezone
 *   (Employee.timezone, IANA; falls back to the entity/site timezone, then
 *   UTC). The @db.Date attendance key is the UTC calendar date of the
 *   employee-local day, so the employeeId+date unique key stays per-local-day.
 *
 * Implemented on Intl.DateTimeFormat — no extra dependency.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/** Validates an IANA timezone; returns the fallback when invalid. */
export function normalizeTimezone(tz: string | null | undefined, fallback = DEFAULT_TIMEZONE): string {
  if (!tz) return fallback;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export interface ZonedDay {
  /** Employee-local calendar date. */
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  /** The @db.Date key: UTC midnight of the employee-local date. */
  dateKey: Date;
}

/**
 * The employee-local "today" for a given instant (default: now), plus the
 * @db.Date key to store/query.
 */
export function zonedToday(timeZone: string, at: Date = new Date()): ZonedDay {
  const tz = normalizeTimezone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return { year, month, day, dateKey: new Date(Date.UTC(year, month - 1, day)) };
}

/**
 * Converts an employee-local wall-clock time ("2026-10-05" + "09:00") to a
 * UTC instant. Handles DST by measuring the zone offset at that local time.
 */
export function zonedTimeToUtc(
  dateStr: string, // YYYY-MM-DD (employee-local)
  timeStr: string, // HH:MM (employee-local)
  timeZone: string,
): Date {
  const tz = normalizeTimezone(timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Guess UTC, then correct by the zone offset at that instant (one
  // iteration is enough: offsets change by whole hours at transitions).
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetMs = zoneOffsetMs(tz, new Date(guess));
  return new Date(guess - offsetMs);
}

/** Offset of `timeZone` at `instant`, in milliseconds (local − UTC). */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - instant.getTime();
}

/**
 * Break + overtime computation (Phase 2, item 5).
 *
 * ASSUMPTIONS (documented; HR policy sign-off pending):
 * - Unpaid break: 60 minutes when the shift (or worked time without a shift)
 *   exceeds 6 hours; 30 minutes when it exceeds 4.5 hours; none otherwise.
 *   (Mirrors UK Working Time Regulations rest-break minima.)
 * - Overtime: minutes worked beyond the scheduled shift length (clockOut −
 *   shiftEnd), floored at 0. Without a scheduled shift, overtime is minutes
 *   beyond 8 hours.
 */
export interface BreakOvertime {
  breakMinutes: number;
  overtimeMinutes: number;
  /** Net worked minutes (gross − break). */
  netMinutes: number;
}

export function computeBreakAndOvertime(
  clockIn: Date,
  clockOut: Date,
  shiftStart?: Date | null,
  shiftEnd?: Date | null,
): BreakOvertime {
  const grossMinutes = Math.max(0, Math.round((clockOut.getTime() - clockIn.getTime()) / 60000));

  const referenceMinutes =
    shiftStart && shiftEnd
      ? Math.max(0, Math.round((shiftEnd.getTime() - shiftStart.getTime()) / 60000))
      : grossMinutes;

  let breakMinutes = 0;
  if (referenceMinutes > 6 * 60) breakMinutes = 60;
  else if (referenceMinutes > 4.5 * 60) breakMinutes = 30;

  const netMinutes = Math.max(0, grossMinutes - breakMinutes);

  let overtimeMinutes: number;
  if (shiftEnd) {
    overtimeMinutes = Math.max(0, Math.round((clockOut.getTime() - shiftEnd.getTime()) / 60000));
  } else {
    overtimeMinutes = Math.max(0, netMinutes - 8 * 60);
  }

  return { breakMinutes, overtimeMinutes, netMinutes };
}
