import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFieldReportNumber,
  nextFieldReportNumber,
} from './field-report-number.js';

describe('formatFieldReportNumber', () => {
  test('formats sequence values with 4-digit zero padding', () => {
    assert.equal(formatFieldReportNumber(2026, 1), 'FR-2026-0001');
    assert.equal(formatFieldReportNumber(2026, 42), 'FR-2026-0042');
    assert.equal(formatFieldReportNumber(2026, 12345), 'FR-2026-12345');
  });

  test('rejects out-of-range year or non-positive sequence', () => {
    assert.throws(() => formatFieldReportNumber(1999, 1));
    assert.throws(() => formatFieldReportNumber(2026, 0));
    assert.throws(() => formatFieldReportNumber(2026, 2.5));
  });
});

describe('nextFieldReportNumber', () => {
  test('queries field_report_number_seq via nextval and formats result', async () => {
    const queries: string[] = [];
    const num = await nextFieldReportNumber(async (sql) => {
      queries.push(sql);
      return [{ n: 101 }];
    }, 2026);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /nextval\('field_report_number_seq'\)/);
    assert.equal(num, 'FR-2026-0101');
  });

  test('throws clearly if field_report_number_seq is missing', async () => {
    await assert.rejects(
      nextFieldReportNumber(async () => []),
      /field_report_number_seq/,
    );
  });
});

