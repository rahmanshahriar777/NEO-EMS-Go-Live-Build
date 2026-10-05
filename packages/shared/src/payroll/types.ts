/**
 * Payroll single-compute contract.
 *
 * The single-compute home is `compute.ts` in this directory: `computePayslip`
 * is the one implementation of payroll math, imported by the worker's
 * payroll processor. The API's payroll service still carries its own
 * adjustment/totals math (payroll.service.ts) — full consolidation of the
 * API path is tracked separately and is NOT claimed here.
 *
 * Money boundary: baseSalary and FIXED component values accept the Prisma
 * Decimal's canonical STRING (`.toString()`); string-based minor-unit
 * conversion (currency.ts) keeps Decimal values exact end-to-end with no
 * float boundary. Plain numbers are parsed through their decimal
 * representation as well.
 */
import type { SalaryComponentType, CalculationType } from '../enums/index.js';

export interface SalaryComponentInput {
  name: string;
  type: SalaryComponentType;
  calculationType: CalculationType;
  /**
   * FIXED: major-unit amount. PERCENTAGE_*: percent value (e.g. 10 = 10%).
   * Accepts the Prisma Decimal's canonical string to keep money exact —
   * never pass `Number(decimal)`; pass `decimal.toString()`.
   */
  value: number | string;
}

export interface PayslipBreakdownLine {
  component: string;
  type: SalaryComponentType;
  /** Major-unit amount, already rounded to the currency's precision. */
  amount: number;
}

export interface ComputedPayslip {
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  breakdown: PayslipBreakdownLine[];
}

export interface PayrollComputeInput {
  /** ISO 4217 code, e.g. 'GBP'. Must match CURRENCY_MINOR_UNITS. */
  currency: string;
  /**
   * Major-unit base salary for the period. Prefer the Decimal's canonical
   * string (`baseSalary.toString()`) — never `Number(decimal)`.
   */
  baseSalary: number | string;
  components: SalaryComponentInput[];
}

/**
 * Canonical payroll formula (as implemented in compute.ts):
 *   gross = baseSalary + Σ earnings
 *   net   = max(0, gross − deductions)
 * PERCENTAGE_OF_BASIC computes off baseSalary; PERCENTAGE_OF_GROSS computes
 * off gross earnings (baseSalary + earnings already applied).
 */
export type PayrollComputeFn = (input: PayrollComputeInput) => ComputedPayslip;
