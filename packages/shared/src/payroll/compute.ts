/**
 * Canonical payroll computation (single-compute home).
 *
 * THIS module is the one implementation of payroll math: the worker's
 * payroll processor imports it. (The worker's legacy
 * `apps/worker/src/processors/payroll-math.ts` duplicate is gone; the API's
 * payroll service still carries its own adjustment/totals math — see the
 * contract note in types.ts.)
 *
 * Formula (Phase 2 item 4, with the PERCENTAGE_OF_GROSS fix):
 *   gross = baseSalary + Σ EARNING components
 *   net   = max(0, gross − deductions)
 *
 * Application order within each side:
 *   1. FIXED components (absolute amounts)
 *   2. PERCENTAGE_OF_BASIC  → value% of baseSalary
 *   3. PERCENTAGE_OF_GROSS  → value% of gross EARNINGS, i.e. baseSalary plus
 *      all EARNING components already applied (fixed and %-of-basic).
 *      Deduction-side PERCENTAGE_OF_GROSS is likewise off gross earnings.
 *
 * The old behaviour (both percentage types computed off baseSalary) was a
 * bug shared by the two previous mirrors; it is fixed here, once.
 *
 * Money: integer minor-unit arithmetic parameterised by currency
 * (see ./currency.ts) — correct for zero-decimal (JPY) and three-decimal
 * (KWD) currencies, not just 2-decimal ones.
 */
import { toMinorUnits, fromMinorUnits } from './currency.js';
import { SalaryComponentType } from '../enums/index.js';
import type {
  SalaryComponentInput,
  PayslipBreakdownLine,
  ComputedPayslip,
  PayrollComputeInput,
} from './types.js';

/**
 * Percent values (PERCENTAGE_OF_BASIC / PERCENTAGE_OF_GROSS) as numbers.
 * String input (Decimal canonical form) is parsed exactly — percentages are
 * small magnitudes where the decimal representation is authoritative.
 */
function toPercentValue(value: number | string, componentName: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`computePayslip: invalid percent value '${value}' on '${componentName}'`);
  }
  return n;
}

export function computePayslip(input: PayrollComputeInput): ComputedPayslip {
  const { currency, baseSalary, components } = input;
  if (typeof baseSalary === 'number' && (!Number.isFinite(baseSalary) || baseSalary < 0)) {
    throw new Error(`computePayslip: invalid baseSalary ${baseSalary}`);
  }
  // String baseSalary (Prisma Decimal canonical form) is validated inside
  // toMinorUnits — exact, no float boundary.

  const baseMinor = toMinorUnits(baseSalary, currency);
  let grossMinor = baseMinor;
  let deductionsMinor = 0;
  const breakdown: PayslipBreakdownLine[] = [
    {
      component: 'Base Salary',
      type: SalaryComponentType.EARNING,
      amount: fromMinorUnits(baseMinor, currency),
    },
  ];

  const applyLine = (comp: SalaryComponentInput, minor: number): void => {
    const amount = fromMinorUnits(minor, currency);
    if (comp.type === SalaryComponentType.EARNING) {
      grossMinor += minor;
      breakdown.push({ component: comp.name, type: SalaryComponentType.EARNING, amount });
    } else {
      deductionsMinor += minor;
      breakdown.push({ component: comp.name, type: SalaryComponentType.DEDUCTION, amount });
    }
  };

  // Earnings first (they define gross), then deductions.
  const sides = [
    components.filter(c => c.type === SalaryComponentType.EARNING),
    components.filter(c => c.type !== SalaryComponentType.EARNING),
  ] as const;

  for (const side of sides) {
    // 1. FIXED — absolute amounts.
    for (const comp of side) {
      if (comp.calculationType !== 'FIXED') continue;
      applyLine(comp, toMinorUnits(comp.value, currency));
    }
    // 2. PERCENTAGE_OF_BASIC — off base salary.
    for (const comp of side) {
      if (comp.calculationType !== 'PERCENTAGE_OF_BASIC') continue;
      applyLine(comp, Math.round((baseMinor * toPercentValue(comp.value, comp.name)) / 100));
    }
    // 3. PERCENTAGE_OF_GROSS — off gross earnings (THE FIX: previously off
    //    base salary, identical to PERCENTAGE_OF_BASIC).
    for (const comp of side) {
      if (comp.calculationType !== 'PERCENTAGE_OF_GROSS') continue;
      applyLine(comp, Math.round((grossMinor * toPercentValue(comp.value, comp.name)) / 100));
    }
  }

  const netMinor = Math.max(0, grossMinor - deductionsMinor);

  return {
    grossPay: fromMinorUnits(grossMinor, currency),
    totalDeductions: fromMinorUnits(deductionsMinor, currency),
    netPay: fromMinorUnits(netMinor, currency),
    breakdown,
  };
}

/** Calendar days in a month (1-based month). Used for joiner/leaver proration. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Prorates a full-period amount by calendar days present in the month.
 * Pure helper for joiner/leaver proration (worker applies it per employee).
 */
export function prorateByCalendarDays(
  fullAmount: number,
  daysPresent: number,
  year: number,
  month: number,
  currency: string,
): number {
  const dim = daysInMonth(year, month);
  const clamped = Math.min(Math.max(daysPresent, 0), dim);
  const minor = toMinorUnits(fullAmount, currency);
  return fromMinorUnits(Math.round((minor * clamped) / dim), currency);
}

/**
 * Daily rate from a monthly amount (for unpaid-leave deductions).
 * Assumption (documented): monthly amount ÷ calendar days in the pay month.
 */
export function dailyRate(
  monthlyAmount: number,
  year: number,
  month: number,
  currency: string,
): number {
  const minor = toMinorUnits(monthlyAmount, currency);
  return fromMinorUnits(Math.round(minor / daysInMonth(year, month)), currency);
}

/**
 * Post-compute deduction lines (e.g. unpaid-leave deductions the worker
 * derives from approved LeaveRequest rows with LeaveType.isPaid = false).
 *
 * Lives here — not in the callers — so the single-compute invariant holds:
 * breakdown lines are appended, totals re-derived in minor units, and net
 * recomputed as max(0, gross − deductions), exactly like computePayslip.
 */
export interface AdditionalDeduction {
  /** Breakdown label, e.g. 'Unpaid Leave (3 days)'. */
  name: string;
  /** Minor-unit amount, already rounded to the currency's precision. */
  amountMinor: number;
}

export function applyAdditionalDeductions(
  payslip: ComputedPayslip,
  deductions: AdditionalDeduction[],
  currency: string,
): ComputedPayslip {
  const grossMinor = toMinorUnits(payslip.grossPay, currency);
  let deductionsMinor = toMinorUnits(payslip.totalDeductions, currency);
  const breakdown = [...payslip.breakdown];
  for (const d of deductions) {
    if (!Number.isInteger(d.amountMinor) || d.amountMinor < 0) {
      throw new Error(`applyAdditionalDeductions: invalid amountMinor ${d.amountMinor}`);
    }
    deductionsMinor += d.amountMinor;
    breakdown.push({
      component: d.name,
      type: SalaryComponentType.DEDUCTION,
      amount: fromMinorUnits(d.amountMinor, currency),
    });
  }
  const netMinor = Math.max(0, grossMinor - deductionsMinor);
  return {
    grossPay: payslip.grossPay,
    totalDeductions: fromMinorUnits(deductionsMinor, currency),
    netPay: fromMinorUnits(netMinor, currency),
    breakdown,
  };
}
