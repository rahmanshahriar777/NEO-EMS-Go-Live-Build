/**
 * Unit tests for employee-number helpers. Run with:
 *   tsx --test src/employee-number.test.ts
 * (node:test + node:assert only — no test framework dependency).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYEE_NUMBER_SEQUENCE_FLOOR,
  computeEmployeeNumberSequenceSeed,
  formatEmployeeNumber,
  nextEmployeeNumber,
  trailingEmployeeDigits,
} from './employee-number.js';

describe('formatEmployeeNumber', () => {
  test('pads the sequence to 4 digits (EMP-YYYY-NNNN)', () => {
    assert.equal(formatEmployeeNumber(2026, 1), 'EMP-2026-0001');
    assert.equal(formatEmployeeNumber(2026, 1000), 'EMP-2026-1000');
    assert.equal(formatEmployeeNumber(2026, 12345), 'EMP-2026-12345');
  });

  test('rejects invalid year / sequence', () => {
    assert.throws(() => formatEmployeeNumber(1999, 1));
    assert.throws(() => formatEmployeeNumber(2026, 0));
    assert.throws(() => formatEmployeeNumber(2026, 1.5));
  });
});

describe('nextEmployeeNumber', () => {
  test('calls nextval on employee_number_seq and formats the result', async () => {
    const seen: string[] = [];
    const number = await nextEmployeeNumber(async (sql) => {
      seen.push(sql);
      return [{ n: 1001 }];
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /nextval\('employee_number_seq'\)/);
    assert.equal(number, `EMP-${new Date().getFullYear()}-1001`);
  });

  test('accepts an explicit year', async () => {
    const number = await nextEmployeeNumber(async () => [{ n: 1000 }], 2030);
    assert.equal(number, 'EMP-2030-1000');
  });

  test('throws (never fabricates) when the sequence is missing', async () => {
    await assert.rejects(
      nextEmployeeNumber(async () => []),
      /employee_number_seq/,
    );
    await assert.rejects(
      nextEmployeeNumber(async () => [{ n: null }]),
      /employee_number_seq/,
    );
  });
});

describe('trailingEmployeeDigits', () => {
  test('extracts the trailing digit run of EMP-YYYY-NNNN', () => {
    assert.equal(trailingEmployeeDigits('EMP-2026-0042'), 42);
    assert.equal(trailingEmployeeDigits('EMP-2026-1000'), 1000);
  });

  test('handles the legacy EMP-NNNNN recruitment format', () => {
    assert.equal(trailingEmployeeDigits('EMP-12345'), 12345);
  });

  test('returns null when there is no trailing digit run', () => {
    assert.equal(trailingEmployeeDigits('EMP-ABC'), null);
    assert.equal(trailingEmployeeDigits(''), null);
    assert.equal(trailingEmployeeDigits(null), null);
    assert.equal(trailingEmployeeDigits(undefined), null);
  });
});

describe('computeEmployeeNumberSequenceSeed (go-live HIGH #8)', () => {
  test('floors at 999 on an empty table — sequence effectively starts at 1000', () => {
    assert.equal(EMPLOYEE_NUMBER_SEQUENCE_FLOOR, 999);
    assert.equal(computeEmployeeNumberSequenceSeed([]), 999);
  });

  test('seeded demo rows EMP-YYYY-0001..0020 stay below the floor', () => {
    const seeded = Array.from({ length: 20 }, (_, i) => `EMP-2026-${String(i + 1).padStart(4, '0')}`);
    // Regression: without the floor, setval(seq, 0) let the first
    // app-created employee re-issue EMP-YYYY-0001 (UNIQUE violation).
    assert.equal(computeEmployeeNumberSequenceSeed(seeded), 999);
  });

  test('stays above the highest existing sequence value', () => {
    assert.equal(
      computeEmployeeNumberSequenceSeed(['EMP-2026-0001', 'EMP-2026-1005', 'EMP-2026-0999']),
      1005,
    );
  });

  test('legacy EMP-NNNNN numbers contribute their full value', () => {
    assert.equal(computeEmployeeNumberSequenceSeed(['EMP-12345']), 12345);
  });

  test('ignores rows with no trailing digits and nullish values', () => {
    assert.equal(
      computeEmployeeNumberSequenceSeed(['EMP-ABC', null, undefined, 'EMP-2026-0500']),
      999,
    );
  });
});
