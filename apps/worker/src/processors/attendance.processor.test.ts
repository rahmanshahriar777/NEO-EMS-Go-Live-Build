/**
 * Unit tests for the nightly absence-marking date logic (pure function; the
 * DB-touching markNightlyAbsences is covered by integration, not here).
 * Run with: tsx --test src/processors/attendance.processor.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { targetDateForTimezone, AUTO_ABSENT_NOTE } from './attendance.processor.js';

describe('targetDateForTimezone', () => {
  test('returns yesterday in UTC', () => {
    assert.equal(
      targetDateForTimezone('UTC', new Date('2026-10-05T01:00:00Z')),
      '2026-10-04',
    );
  });

  test('handles month boundaries', () => {
    assert.equal(
      targetDateForTimezone('UTC', new Date('2026-11-01T12:00:00Z')),
      '2026-10-31',
    );
  });

  test('uses the entity timezone, not the server timezone (ahead of UTC)', () => {
    // 2026-10-05 01:00 UTC = 07:00 in Dhaka → local "today" is the 5th.
    assert.equal(
      targetDateForTimezone('Asia/Dhaka', new Date('2026-10-05T01:00:00Z')),
      '2026-10-04',
    );
  });

  test('uses the entity timezone, not the server timezone (behind UTC)', () => {
    // 2026-10-05 03:00 UTC = 23:00 on the 4th in New York → local "today" is the 4th.
    assert.equal(
      targetDateForTimezone('America/New_York', new Date('2026-10-05T03:00:00Z')),
      '2026-10-03',
    );
  });

  test('defaults the now parameter to the current time and returns YYYY-MM-DD', () => {
    assert.match(targetDateForTimezone('UTC'), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('AUTO_ABSENT_NOTE', () => {
  test('is a non-empty audit-friendly note', () => {
    assert.ok(AUTO_ABSENT_NOTE.length > 10);
  });
});
