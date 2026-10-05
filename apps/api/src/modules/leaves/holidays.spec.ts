import { countWorkingDays, splitRangeByYear, workingDaysPerYear, startOfDay } from './holidays';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Pure working-day utilities (F14). Calendar fixtures verified:
 * 2026-10-10/11 = Sat/Sun, 2026-10-12..16 = Mon..Fri, 2027-01-01 = Fri.
 */
describe('leave working-day utilities', () => {
  describe('startOfDay', () => {
    it('normalises to UTC midnight', () => {
      expect(startOfDay(new Date('2026-10-12T15:30:00Z'))).toEqual(d('2026-10-12'));
    });
  });

  describe('countWorkingDays', () => {
    it('counts Mon-Fri in a full week', () => {
      expect(countWorkingDays(d('2026-10-12'), d('2026-10-16'), [])).toBe(5);
    });

    it('excludes weekends', () => {
      expect(countWorkingDays(d('2026-10-10'), d('2026-10-11'), [])).toBe(0);
      expect(countWorkingDays(d('2026-10-09'), d('2026-10-12'), [])).toBe(2); // Fri + Mon
    });

    it('excludes holidays', () => {
      expect(countWorkingDays(d('2026-10-12'), d('2026-10-14'), [d('2026-10-13')])).toBe(2);
    });

    it('ignores holidays that fall on weekends', () => {
      expect(countWorkingDays(d('2026-10-10'), d('2026-10-11'), [d('2026-10-10')])).toBe(0);
    });

    it('counts a single working day', () => {
      expect(countWorkingDays(d('2026-10-12'), d('2026-10-12'), [])).toBe(1);
    });

    it('returns 0 for a reversed range', () => {
      expect(countWorkingDays(d('2026-10-14'), d('2026-10-12'), [])).toBe(0);
    });
  });

  describe('splitRangeByYear', () => {
    it('returns one segment inside a single year', () => {
      const segs = splitRangeByYear(d('2026-03-01'), d('2026-03-05'));

      expect(segs).toHaveLength(1);
      expect(segs[0]).toMatchObject({ year: 2026, start: d('2026-03-01'), end: d('2026-03-05') });
    });

    it('splits at the year boundary', () => {
      const segs = splitRangeByYear(d('2026-12-30'), d('2027-01-05'));

      expect(segs).toHaveLength(2);
      expect(segs[0]).toMatchObject({ year: 2026, start: d('2026-12-30'), end: d('2026-12-31') });
      expect(segs[1]).toMatchObject({ year: 2027, start: d('2027-01-01'), end: d('2027-01-05') });
    });

    it('returns [] for a reversed range', () => {
      expect(splitRangeByYear(d('2026-03-05'), d('2026-03-01'))).toEqual([]);
    });
  });

  describe('workingDaysPerYear', () => {
    it('charges days per year segment', () => {
      // 2026: Dec 30-31 (Wed-Thu) = 2; 2027: Jan 1 (Fri), 4-5 (Mon-Tue) = 3
      const segs = workingDaysPerYear(d('2026-12-30'), d('2027-01-05'), []);

      expect(segs).toEqual([
        { year: 2026, days: 2 },
        { year: 2027, days: 3 },
      ]);
    });

    it('drops segments with zero working days', () => {
      // 2026-12-31 is a Thursday, but 2027-01-01..03 = Fri..Sun with a holiday on Fri
      const segs = workingDaysPerYear(d('2026-12-31'), d('2027-01-03'), [d('2027-01-01')]);

      expect(segs).toEqual([{ year: 2026, days: 1 }]);
    });

    it('applies holidays to the matching segment', () => {
      const segs = workingDaysPerYear(d('2026-12-30'), d('2027-01-05'), [d('2026-12-31')]);

      expect(segs).toEqual([
        { year: 2026, days: 1 },
        { year: 2027, days: 3 },
      ]);
    });
  });
});
