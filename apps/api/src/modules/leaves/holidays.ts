/**
 * Working-day utilities for leave accounting (F14).
 *
 * Rules:
 * - Working days are Monday–Friday minus holidays.
 * - Holidays come from the Holiday table (fetched by the caller); this module
 *   is intentionally a small local util for now.
 *
 * NOTE (unification): a shared holiday provider (regional calendars,
 * recurring statutory holidays) should replace this local util once defined.
 * Tracked as follow-up — see final release report.
 */

export interface YearSegment {
  year: number;
  start: Date;
  end: Date;
}

function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalises a Date to UTC midnight for day-level comparisons. */
export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/**
 * Counts working days in [start, end], inclusive, given holidays.
 *
 * `workingDays` is the working-week pattern (0 = Sunday … 6 = Saturday);
 * defaults to Monday–Friday. Phase 2, item 6: per-policy working weeks.
 * Dates are compared at day granularity (UTC).
 */
export function countWorkingDays(start: Date, end: Date, holidays: Date[], workingDays: number[] = [1, 2, 3, 4, 5]): number {
  const s = startOfDay(start);
  const e = startOfDay(end);
  if (e < s) return 0;

  const holidayKeys = new Set(holidays.map(toDayKey));
  const working = new Set(workingDays);
  let count = 0;
  const cursor = new Date(s);
  while (cursor <= e) {
    const day = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (working.has(day) && !holidayKeys.has(toDayKey(cursor))) {
      count++;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * Splits a date range into per-calendar-year segments so cross-year leave
 * requests can be charged against each year's balance (F14).
 */
export function splitRangeByYear(start: Date, end: Date): YearSegment[] {
  const s = startOfDay(start);
  const e = startOfDay(end);
  if (e < s) return [];

  const segments: YearSegment[] = [];
  let segStart = new Date(s);
  while (segStart <= e) {
    const year = segStart.getUTCFullYear();
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const segEnd = e < yearEnd ? e : yearEnd;
    segments.push({ year, start: new Date(segStart), end: new Date(segEnd) });
    segStart = new Date(Date.UTC(year + 1, 0, 1));
  }
  return segments;
}

/**
 * Working days per year segment for a leave range, given holidays.
 * Segments with zero working days are dropped (they consume no balance).
 */
export function workingDaysPerYear(
  start: Date,
  end: Date,
  holidays: Date[],
  workingDays?: number[],
): Array<{ year: number; days: number }> {
  return splitRangeByYear(start, end)
    .map((seg) => ({ year: seg.year, days: countWorkingDays(seg.start, seg.end, holidays, workingDays) }))
    .filter((seg) => seg.days > 0);
}
