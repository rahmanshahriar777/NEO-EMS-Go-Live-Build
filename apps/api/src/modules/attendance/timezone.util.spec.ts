import {
  normalizeTimezone,
  zonedToday,
  zonedTimeToUtc,
  computeBreakAndOvertime,
} from './timezone.util';

describe('timezone utils', () => {
  it('normalizes invalid timezones to UTC', () => {
    expect(normalizeTimezone('Europe/London')).toBe('Europe/London');
    expect(normalizeTimezone('Not/AZone')).toBe('UTC');
    expect(normalizeTimezone(null)).toBe('UTC');
  });

  it('computes employee-local today (day boundary in zone)', () => {
    // 2026-10-05T00:30:00Z is still 2026-10-04 in New York (UTC-4).
    const at = new Date('2026-10-05T00:30:00Z');
    const ny = zonedToday('America/New_York', at);
    expect([ny.year, ny.month, ny.day]).toEqual([2026, 10, 4]);
    expect(ny.dateKey.toISOString()).toBe('2026-10-04T00:00:00.000Z');

    const london = zonedToday('Europe/London', at);
    expect([london.year, london.month, london.day]).toEqual([2026, 10, 5]);
  });

  it('converts zoned shift times to UTC across DST', () => {
    // London winter (UTC+0): 09:00 local = 09:00Z.
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    );
    // London summer (UTC+1): 09:00 local = 08:00Z.
    expect(zonedTimeToUtc('2026-07-15', '09:00', 'Europe/London').toISOString()).toBe(
      '2026-07-15T08:00:00.000Z',
    );
  });

  it('computes breaks and overtime with documented assumptions', () => {
    const clockIn = new Date('2026-10-05T08:00:00Z');
    const clockOut = new Date('2026-10-05T18:30:00Z'); // 10.5h gross
    const shiftEnd = new Date('2026-10-05T17:00:00Z');

    const r = computeBreakAndOvertime(clockIn, clockOut, new Date('2026-10-05T08:00:00Z'), shiftEnd);
    expect(r.breakMinutes).toBe(60); // > 6h shift
    expect(r.overtimeMinutes).toBe(90); // 18:30 − 17:00
    expect(r.netMinutes).toBe(630 - 60);

    // Short shift: no break, no overtime.
    const short = computeBreakAndOvertime(
      new Date('2026-10-05T09:00:00Z'),
      new Date('2026-10-05T13:00:00Z'),
      new Date('2026-10-05T09:00:00Z'),
      new Date('2026-10-05T13:00:00Z'),
    );
    expect(short.breakMinutes).toBe(0);
    expect(short.overtimeMinutes).toBe(0);
  });
});
