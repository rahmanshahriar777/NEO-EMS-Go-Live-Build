/**
 * Unit tests for shared utils. Run with: tsx --test src/utils/utils.test.ts
 * (node:test + node:assert only — no test framework dependency).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CurrencyUtil, DateUtil, PiiRedactor, DEFAULT_CURRENCY, UK_BANK_HOLIDAYS } from './index.js';

describe('CurrencyUtil', () => {
  test('default currency is GBP (configurable via DEFAULT_CURRENCY env)', () => {
    assert.equal(DEFAULT_CURRENCY, 'GBP');
  });

  test('format() defaults to GBP', () => {
    assert.match(CurrencyUtil.format(1234.5), /£1,234\.50/);
  });

  test('cents round-trip is exact', () => {
    assert.equal(CurrencyUtil.fromMinorUnits(CurrencyUtil.toMinorUnits(19.99)), 19.99);
    assert.equal(CurrencyUtil.toMinorUnits(0.1 + 0.2), 30); // no float drift
  });

  test('calculateComponent handles FIXED and percentages', () => {
    assert.equal(CurrencyUtil.calculateComponent(5000, 'FIXED', 500), 500);
    assert.equal(CurrencyUtil.calculateComponent(5000, 'PERCENTAGE_OF_BASIC', 40), 2000);
    assert.equal(CurrencyUtil.calculateComponent(5000, 'PERCENTAGE_OF_GROSS', 15), 750);
  });
});

describe('DateUtil.getEnglandWalesBankHolidays', () => {
  test('2026: standard 8 holidays with correct dates', () => {
    assert.deepEqual(DateUtil.getEnglandWalesBankHolidays(2026), [
      '2026-01-01', // New Year's Day (Thursday)
      '2026-04-03', // Good Friday
      '2026-04-06', // Easter Monday
      '2026-05-04', // Early May
      '2026-05-25', // Spring
      '2026-08-31', // Summer
      '2026-12-25', // Christmas Day (Friday)
      '2026-12-28', // Boxing Day substitute (26th is Saturday)
    ]);
  });

  test('2022: Christmas Sunday -> substitute Tuesday (no Boxing Day collision)', () => {
    const h = DateUtil.getEnglandWalesBankHolidays(2022);
    // Dec 25 2022 was a Sunday: only the observed dates are listed.
    assert.ok(!h.includes('2022-12-25'));
    assert.ok(h.includes('2022-12-26')); // Boxing Day itself (Monday)
    assert.ok(h.includes('2022-12-27')); // Christmas substitute (Tuesday)
    assert.ok(h.includes('2022-01-03')); // New Year substitute (Jan 1 Saturday)
    assert.equal(h.length, 8);
  });

  test('2021: Christmas Saturday + Boxing Sunday -> Mon 27 + Tue 28', () => {
    const h = DateUtil.getEnglandWalesBankHolidays(2021);
    assert.ok(h.includes('2021-12-27'));
    assert.ok(h.includes('2021-12-28'));
  });

  test('UK_BANK_HOLIDAYS snapshot is a non-empty ISO-date list', () => {
    assert.ok(UK_BANK_HOLIDAYS.length >= 8);
    for (const d of UK_BANK_HOLIDAYS) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('DateUtil.calculateWorkingDaysBetween', () => {
  test('full working week = 5', () => {
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-05', '2026-10-09'), 5);
  });

  test('weekends excluded', () => {
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-05', '2026-10-11'), 5);
  });

  test('bank holidays excluded by default', () => {
    // Thu 24 .. Mon 28 Dec 2026: Fri 25th (Christmas) and Mon 28th
    // (Boxing Day substitute) are bank holidays -> only the 24th counts.
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-12-24', '2026-12-28'), 1);
  });

  test('custom holiday list overrides defaults', () => {
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-05', '2026-10-09', ['2026-10-07']), 4);
  });

  test('single day and reversed ranges', () => {
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-05', '2026-10-05'), 1);
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-09', '2026-10-05'), 5);
    assert.equal(DateUtil.calculateWorkingDaysBetween('2026-10-10', '2026-10-10'), 0); // Saturday
  });
});

describe('PiiRedactor', () => {
  test('redacts UK National Insurance numbers', () => {
    assert.equal(
      PiiRedactor.redactNationalInsuranceNumber('NI: QQ 12 34 56 C ok'),
      'NI: [REDACTED_NI_NUMBER] ok',
    );
    assert.equal(
      PiiRedactor.redactNationalInsuranceNumber('AB123456C'),
      '[REDACTED_NI_NUMBER]',
    );
  });

  test('redacts UK postcodes', () => {
    assert.equal(PiiRedactor.redactUKPostcode('lives at SW1A 1AA London'), 'lives at [REDACTED_POSTCODE] London');
    assert.equal(PiiRedactor.redactUKPostcode('M1 1AE'), '[REDACTED_POSTCODE]');
  });

  test('sanitizePrompt covers NI numbers, postcodes and UK phones', () => {
    const out = PiiRedactor.sanitizePrompt('Employee QQ123456C at SW1A 1AA called 07700 900123');
    assert.ok(out.includes('[REDACTED_NI_NUMBER]'));
    assert.ok(out.includes('[REDACTED_POSTCODE]'));
    assert.ok(out.includes('[REDACTED_UK_PHONE]'));
  });

  test('does not redact ordinary text', () => {
    assert.equal(PiiRedactor.sanitizePrompt('Summarise the leave policy'), 'Summarise the leave policy');
  });
});
