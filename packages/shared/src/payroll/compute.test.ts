/**
 * Unit tests for the canonical payroll computation.
 * Run with: tsx --test src/payroll/compute.test.ts
 * (node:test + node:assert only — no test framework dependency).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePayslip,
  prorateByCalendarDays,
  dailyRate,
  daysInMonth,
  toMinorUnits,
  toMinorUnitsExact,
  applyAdditionalDeductions,
} from './index.js';

describe('computePayslip (canonical single-compute)', () => {
  test('base salary only: gross == net', () => {
    const r = computePayslip({ currency: 'GBP', baseSalary: 5000, components: [] });
    assert.equal(r.grossPay, 5000);
    assert.equal(r.totalDeductions, 0);
    assert.equal(r.netPay, 5000);
    assert.equal(r.breakdown.length, 1);
  });

  test('FIXED earning + FIXED deduction', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: 5000,
      components: [
        { name: 'Bonus', type: 'EARNING', calculationType: 'FIXED', value: 500 },
        { name: 'Pension', type: 'DEDUCTION', calculationType: 'FIXED', value: 200 },
      ],
    });
    assert.equal(r.grossPay, 5500);
    assert.equal(r.totalDeductions, 200);
    assert.equal(r.netPay, 5300);
  });

  test('PERCENTAGE_OF_BASIC is off base salary', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: 5000,
      components: [{ name: 'Housing', type: 'EARNING', calculationType: 'PERCENTAGE_OF_BASIC', value: 20 }],
    });
    assert.equal(r.grossPay, 6000); // 5000 + 20% of 5000
  });

  test('PERCENTAGE_OF_GROSS is off gross earnings (the fix)', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: 5000,
      components: [
        { name: 'Housing', type: 'EARNING', calculationType: 'PERCENTAGE_OF_BASIC', value: 20 }, // +1000
        { name: 'Tax', type: 'DEDUCTION', calculationType: 'PERCENTAGE_OF_GROSS', value: 10 }, // 10% of 6000
      ],
    });
    assert.equal(r.grossPay, 6000);
    assert.equal(r.totalDeductions, 600); // NOT 500 (the old off-base bug)
    assert.equal(r.netPay, 5400);
  });

  test('earning-side PERCENTAGE_OF_GROSS compounds on prior earnings', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: 10000,
      components: [
        { name: 'Allowance', type: 'EARNING', calculationType: 'PERCENTAGE_OF_GROSS', value: 10 },
      ],
    });
    // 10% of 10000 (no prior earnings) = 1000
    assert.equal(r.grossPay, 11000);
  });

  test('net is floored at zero', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: 1000,
      components: [{ name: 'Huge', type: 'DEDUCTION', calculationType: 'FIXED', value: 5000 }],
    });
    assert.equal(r.netPay, 0);
  });

  test('zero-decimal currency (JPY) rounds to whole units', () => {
    const r = computePayslip({
      currency: 'JPY',
      baseSalary: 300000,
      components: [{ name: 'Tax', type: 'DEDUCTION', calculationType: 'PERCENTAGE_OF_GROSS', value: 10 }],
    });
    assert.equal(r.totalDeductions, 30000);
    assert.equal(Number.isInteger(r.netPay), true);
  });

  test('rejects invalid base salary', () => {
    assert.throws(() => computePayslip({ currency: 'GBP', baseSalary: -1, components: [] }));
    assert.throws(() => computePayslip({ currency: 'GBP', baseSalary: NaN, components: [] }));
  });
});

describe('proration helpers', () => {
  test('daysInMonth handles leap years', () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2026, 9), 30);
  });

  test('prorateByCalendarDays scales linearly and clamps', () => {
    // 15 of 30 days in September 2026
    assert.equal(prorateByCalendarDays(3000, 15, 2026, 9, 'GBP'), 1500);
    // more days than in month clamps to full
    assert.equal(prorateByCalendarDays(3000, 99, 2026, 9, 'GBP'), 3000);
  });

  test('dailyRate divides by calendar days', () => {
    assert.equal(dailyRate(3000, 2026, 9, 'GBP'), 100); // 3000 / 30
  });
});

describe('string-based minor-unit conversion (Decimal end-to-end)', () => {
  test('toMinorUnitsExact parses Decimal strings exactly (no float boundary)', () => {
    assert.equal(toMinorUnitsExact('5000', 'GBP'), 500000);
    assert.equal(toMinorUnitsExact('1234.56', 'GBP'), 123456);
    assert.equal(toMinorUnitsExact('1234.5', 'GBP'), 123450);
    // 0.07 cannot be represented exactly in binary — the string form is exact.
    assert.equal(toMinorUnitsExact('0.07', 'GBP'), 7);
    assert.equal(toMinorUnitsExact('19.99', 'GBP'), 1999);
  });

  test('toMinorUnitsExact rounds half-up at the currency precision', () => {
    assert.equal(toMinorUnitsExact('1.005', 'GBP'), 101); // half-up
    assert.equal(toMinorUnitsExact('1.004', 'GBP'), 100);
    assert.equal(toMinorUnitsExact('1234.5', 'JPY'), 1235); // zero-decimal
    assert.equal(toMinorUnitsExact('1.2345', 'KWD'), 1235); // three-decimal, half-up
  });

  test('toMinorUnitsExact rejects negatives and non-decimals', () => {
    assert.throws(() => toMinorUnitsExact('-1.00', 'GBP'));
    assert.throws(() => toMinorUnitsExact('1e3', 'GBP'));
    assert.throws(() => toMinorUnitsExact('abc', 'GBP'));
  });

  test('toMinorUnits accepts Prisma Decimal canonical strings', () => {
    // Decimal.toString() output shape: '5000.00'
    assert.equal(toMinorUnits('5000.00', 'GBP'), 500000);
    assert.equal(toMinorUnits(5000, 'GBP'), 500000); // number path unchanged
  });

  test('computePayslip accepts string baseSalary and FIXED values', () => {
    const r = computePayslip({
      currency: 'GBP',
      baseSalary: '5000.00',
      components: [
        { name: 'Bonus', type: 'EARNING' as any, calculationType: 'FIXED' as any, value: '250.50' },
      ],
    });
    assert.equal(r.grossPay, 5250.5);
    assert.equal(r.netPay, 5250.5);
  });

  test('applyAdditionalDeductions appends a line and recomputes net', () => {
    const base = computePayslip({ currency: 'GBP', baseSalary: 3000, components: [] });
    const r = applyAdditionalDeductions(
      base,
      [{ name: 'Unpaid Leave (2 days)', amountMinor: 20000 }],
      'GBP',
    );
    assert.equal(r.grossPay, 3000);
    assert.equal(r.totalDeductions, 200);
    assert.equal(r.netPay, 2800);
    assert.equal(r.breakdown.length, base.breakdown.length + 1);
    assert.equal(r.breakdown[r.breakdown.length - 1].component, 'Unpaid Leave (2 days)');
  });
});
