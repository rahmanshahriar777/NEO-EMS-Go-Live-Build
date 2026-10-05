import { Job } from 'bullmq';
import { Prisma, prisma } from '@ems/database';
import type { PayrollJobPayload } from '@ems/shared';
import {
  computePayslip,
  applyAdditionalDeductions,
  prorateByCalendarDays,
  daysInMonth,
  toMinorUnits,
  fromMinorUnits,
  type SalaryComponentInput,
} from '@ems/shared';
import { log } from '../logger.js';

/**
 * Real payroll processor.
 *
 * SINGLE-COMPUTE: the canonical payroll math lives in
 * `packages/shared/src/payroll/compute.ts` and is imported here. This
 * processor only orchestrates (eligibility, proration, unpaid-leave
 * deductions, upserts, totals). Never duplicate the formula — change it in
 * exactly one place. (Note: the API's payroll service still carries its own
 * adjustment/totals math; the worker does NOT share math with the API yet —
 * full consolidation is tracked separately.)
 *
 * For every eligible employee in the run's scope it computes a payslip from
 * the employee's active salary structure, upserts the payslip rows, and
 * rolls the totals up to the run — all inside ONE database transaction, so
 * a crash can never leave a half-computed run.
 *
 * Idempotency (two layers):
 *   1. JobId-based: producers set a stable `jobId` (`payroll-run:<id>`) so
 *      BullMQ dedupes at enqueue time; `idempotencyKey` in the payload marks
 *      the logical operation.
 *   2. Upsert-based: payslips upsert on @@unique([payrollRunId, employeeId]),
 *      so a retried job — including one resuming a crashed PROCESSING run —
 *      converges instead of double-paying.
 *
 * Eligibility (go-live Phase 1 item 2; v4 fix #8): non-deleted employees
 * whose employment status is payable — FULL_TIME, PART_TIME, CONTRACT,
 * PROBATION, INTERN — with an active salary structure. TERMINATED / RESIGNED
 * employees are ALSO fetched: those whose exit date (contractEnd or
 * terminationDate) falls inside the pay month are paid pro-rata for days
 * worked (final pay); exited employees outside the pay month, or with no
 * exit date at all, are excluded with a LOUD warning (never silently).
 * Runs scoped to a department only cover that department; company-wide runs
 * (departmentId null) cover everyone.
 */

/**
 * Employment statuses that earn pay. Exported for unit tests.
 */
export const PAYABLE_EMPLOYMENT_STATUSES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'PROBATION',
  'INTERN',
] as const;

/**
 * Exit statuses. Not "payable" in the ongoing sense, but a leaver whose
 * exit date falls inside the pay month is owed pro-rata final pay (v4 #8).
 * Exported for unit tests.
 */
export const EXITED_EMPLOYMENT_STATUSES = ['TERMINATED', 'RESIGNED'] as const;

/** Prisma `where` for payroll eligibility — pure, unit-tested. */
export function buildEligibilityWhere(run: { departmentId?: string | null }) {
  return {
    deletedAt: null,
    status: { in: [...PAYABLE_EMPLOYMENT_STATUSES, ...EXITED_EMPLOYMENT_STATUSES] },
    ...(run.departmentId ? { departmentId: run.departmentId } : {}),
    salaryStructures: { some: { isActive: true } },
  };
}

/** UTC bounds of a pay month: [start of day 1, end of last day]. */
export function payMonthBounds(year: number, month: number): { start: Date; end: Date } {
  const dim = daysInMonth(year, month);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month - 1, dim, 23, 59, 59, 999)),
  };
}

export type ExclusionCode =
  | 'TERMINATED_BEFORE_PERIOD'
  | 'TERMINATION_DATE_MISSING'
  | 'NOT_EMPLOYED_IN_PERIOD'
  | 'STATUS_NOT_PAYABLE';

/** One employee excluded from a run — persisted on the run, never silent. */
export interface PayrollExclusionWarning {
  code: ExclusionCode;
  employeeId: string;
  employeeNumber?: string | null;
  email?: string | null;
  reason: string;
}

type ClassifiableEmployee = {
  status: string;
  contractStart?: Date | null;
  contractEnd?: Date | null;
  terminationDate?: Date | null;
};

/**
 * Decide whether a fetched employee is paid in this run (v4 fix #8).
 * Pure and unit-tested.
 *
 * - Payable statuses → always eligible; joiner proration happens later via
 *   daysPresentInMonth.
 * - TERMINATED / RESIGNED → eligible only when the exit date (contractEnd
 *   or terminationDate) falls inside the pay month, so mid-month leavers
 *   get pro-rata final pay. Leavers who exited before the month, or whose
 *   exit date was never recorded, are excluded with a loud reason.
 * - Anything else → excluded.
 */
export function classifyEligibility(
  emp: ClassifiableEmployee,
  year: number,
  month: number,
): { eligible: boolean; code?: ExclusionCode; reason?: string } {
  if ((PAYABLE_EMPLOYMENT_STATUSES as readonly string[]).includes(emp.status)) {
    return { eligible: true };
  }
  if ((EXITED_EMPLOYMENT_STATUSES as readonly string[]).includes(emp.status)) {
    const { start, end } = payMonthBounds(year, month);
    // Plain boolean (not a type predicate): narrowing a `d is Date` guard on
    // these property reads would collapse the later ?? chain to `never`.
    const inMonth = (d: Date | null | undefined): boolean =>
      d instanceof Date && d >= start && d <= end;
    if (inMonth(emp.contractEnd) || inMonth(emp.terminationDate)) {
      return { eligible: true };
    }
    const exitDate: Date | null = emp.contractEnd ?? emp.terminationDate ?? null;
    if (!exitDate) {
      return {
        eligible: false,
        code: 'TERMINATION_DATE_MISSING',
        reason:
          `status is ${emp.status} but neither contractEnd nor terminationDate is set — ` +
          `final pay cannot be computed. Set the termination date and re-run.`,
      };
    }
    if (exitDate < start) {
      return {
        eligible: false,
        code: 'TERMINATED_BEFORE_PERIOD',
        reason:
          `status is ${emp.status} with exit date ${exitDate.toISOString().slice(0, 10)}, ` +
          `before the pay period`,
      };
    }
    return {
      eligible: false,
      code: 'NOT_EMPLOYED_IN_PERIOD',
      reason: `exit date is after the pay period; contract does not cover the pay month`,
    };
  }
  return {
    eligible: false,
    code: 'STATUS_NOT_PAYABLE',
    reason: `status ${emp.status} is not payable`,
  };
}

type EmployeeQueryClient = {
  // `any`-typed so both the real PrismaClient delegate and test mocks satisfy it.
  employee: { findMany: (args: any) => Promise<any> };
};

/** Eligible employees with their active salary structure + components. */
export async function fetchEligibleEmployees(
  client: EmployeeQueryClient,
  run: { departmentId?: string | null },
): Promise<any[]> {
  return client.employee.findMany({
    where: buildEligibilityWhere(run),
    include: {
      salaryStructures: {
        where: { isActive: true },
        include: { salaryStructure: { include: { components: true } } },
      },
    },
  });
}

/**
 * Calendar days of the pay month the employee's contract covers (go-live
 * Phase 2 item 4 — joiner/leaver proration). contractStart/contractEnd are
 * the source of truth; null means "no bound on that side". Day-granular in
 * UTC so time-of-day on the contract timestamps cannot shift the count.
 */
export function daysPresentInMonth(
  contractStart: Date | null | undefined,
  contractEnd: Date | null | undefined,
  year: number,
  month: number,
): number {
  const dim = daysInMonth(year, month);
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month - 1, dim);
  let start = monthStart;
  let end = monthEnd;
  if (contractStart) {
    const cs = Date.UTC(
      contractStart.getUTCFullYear(),
      contractStart.getUTCMonth(),
      contractStart.getUTCDate(),
    );
    if (cs > start) start = cs;
  }
  if (contractEnd) {
    const ce = Date.UTC(
      contractEnd.getUTCFullYear(),
      contractEnd.getUTCMonth(),
      contractEnd.getUTCDate(),
    );
    if (ce < end) end = ce;
  }
  if (end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Calendar-day overlap of [startA, endA] with the month window (ms bounds). */
function overlapDays(startA: Date, endA: Date, windowStartMs: number, windowEndMs: number): number {
  const s = Math.max(
    Date.UTC(startA.getUTCFullYear(), startA.getUTCMonth(), startA.getUTCDate()),
    windowStartMs,
  );
  const e = Math.min(
    Date.UTC(endA.getUTCFullYear(), endA.getUTCMonth(), endA.getUTCDate()),
    windowEndMs,
  );
  if (e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

type LeaveQueryClient = {
  // `any`-typed so both the real PrismaClient delegate and test mocks satisfy it.
  leaveRequest: { findMany: (args: any) => Promise<any> };
};

/**
 * Unpaid-leave days in the pay month for one employee (go-live Phase 2
 * item 4): APPROVED requests overlapping the month whose LeaveType.isPaid
 * is false. Assumptions (documented): calendar-day overlap (not
 * working-day counting — the payroll deduction is a daily-rate matter, not
 * a balance matter); half-day requests count 0.5 regardless of clipping.
 */
export async function fetchUnpaidLeaveDays(
  client: LeaveQueryClient,
  employeeId: string,
  year: number,
  month: number,
): Promise<number> {
  const dim = daysInMonth(year, month);
  const windowStart = new Date(Date.UTC(year, month - 1, 1));
  const windowEnd = new Date(Date.UTC(year, month - 1, dim, 23, 59, 59, 999));
  const windowStartMs = windowStart.getTime();
  const windowEndMs = Date.UTC(year, month - 1, dim);
  const requests = await client.leaveRequest.findMany({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: windowEnd },
      endDate: { gte: windowStart },
      leaveType: { isPaid: false },
    },
    select: {
      startDate: true,
      endDate: true,
      halfDay: true,
    },
  });
  let days = 0;
  for (const r of requests) {
    if (r.halfDay === true) {
      days += 0.5;
      continue;
    }
    days += overlapDays(r.startDate, r.endDate, windowStartMs, windowEndMs);
  }
  return days;
}

type PayrollDbClient = EmployeeQueryClient &
  LeaveQueryClient & {
    payrollRun: {
      findUnique: (args: any) => Promise<any>;
      findUniqueOrThrow: (args: any) => Promise<any>;
      update: (args: any) => Promise<any>;
    };
    payslip: { upsert: (args: any) => any };
    $transaction: (ops: any[]) => Promise<any>;
  };

/**
 * BullMQ entry point: delegates to computePayrollRun with the real Prisma
 * singleton. (Kept as a one-arg function so it stays assignable to BullMQ's
 * `Processor` type; tests target computePayrollRun with a mock client.)
 */
export async function processPayroll(job: Job<PayrollJobPayload>) {
  return computePayrollRun(job, prisma as unknown as PayrollDbClient);
}

/**
 * The full compute, parameterised by DB client. Production passes the real
 * Prisma singleton via processPayroll; tests inject a mock. Every DB touch
 * in the compute goes through `db`.
 */
export async function computePayrollRun(job: Job<PayrollJobPayload>, db: PayrollDbClient) {
  const { payrollRunId, correlationId } = job.data;
  log.info('payroll.compute.start', { jobId: job.id, payrollRunId, correlationId });

  const run = await db.payrollRun.findUnique({ where: { id: payrollRunId } });
  if (!run) {
    throw new Error(`Payroll run ${payrollRunId} not found; refusing to compute phantom payslips.`);
  }
  if (run.status === 'APPROVED' || run.status === 'PAID' || run.status === 'CANCELLED') {
    // Past DRAFT the payslips are immutable — recomputing would rewrite
    // history. Loud skip, not a silent no-op.
    log.warn('payroll.compute.skip', {
      jobId: job.id,
      payrollRunId,
      status: run.status,
      reason: 'run is past DRAFT; payslips are immutable past this point',
    });
    return { skipped: true, reason: 'run is immutable', status: run.status };
  }
  // DRAFT → mark PROCESSING. PROCESSING → resume: a previous attempt crashed
  // after marking PROCESSING but before committing. The upserts below
  // converge on retry, so resume is safe and prevents runs stuck forever.
  if (run.status === 'DRAFT') {
    await db.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: 'PROCESSING' },
    });
  } else {
    log.info('payroll.compute.resume', { jobId: job.id, payrollRunId, status: run.status });
  }

  // Minor-unit exact totals (currency-aware — correct for JPY/KWD, not just
  // 2-decimal currencies). Falls back to PAYROLL_CURRENCY env var, then 'GBP'.
  const currency =
    (run as { currency?: string | null }).currency ||
    process.env.PAYROLL_CURRENCY ||
    'GBP';
  const { year, month } = run;
  const dim = daysInMonth(year, month);

  // v4 fix #8: the fetch includes TERMINATED/RESIGNED (see
  // buildEligibilityWhere). Each fetched employee is classified; anyone not
  // payable in this month is EXCLUDED LOUDLY — a structured warn log AND a
  // warning row persisted on the run (surfaced via GET /payroll/runs/:id).
  // Never silent: a mid-month leaver with no exit date recorded is a data
  // problem HR must fix, not a $0 payslip.
  const fetched = await fetchEligibleEmployees(db, run);
  const warnings: PayrollExclusionWarning[] = [];
  const exclude = (emp: any, code: ExclusionCode, reason: string): void => {
    const warning: PayrollExclusionWarning = {
      code,
      employeeId: emp.id,
      employeeNumber: emp.employeeNumber ?? null,
      email: emp.email ?? null,
      reason,
    };
    warnings.push(warning);
    log.warn('payroll.compute.excluded', { jobId: job.id, payrollRunId, ...warning });
  };

  const employees: any[] = [];
  for (const emp of fetched) {
    const decision = classifyEligibility(emp, year, month);
    if (!decision.eligible) {
      exclude(emp, decision.code as ExclusionCode, decision.reason as string);
      continue;
    }
    employees.push(emp);
  }

  if (employees.length === 0) {
    await db.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: 'DRAFT', warnings, processedAt: new Date() },
    });
    const summary =
      warnings.map((w) => `${w.employeeNumber ?? w.employeeId}: ${w.reason}`).join(' | ') ||
      'none fetched';
    throw new Error(
      `No eligible employees with active salary structures for run ${payrollRunId}. ` +
        `Excluded (${warnings.length}): ${summary}`,
    );
  }

  let totalGrossMinor = 0;
  let totalDeductionsMinor = 0;
  let totalNetMinor = 0;
  let computed = 0;

  // Compute every payslip first, then commit ALL writes (payslip upserts +
  // run totals) in a single transaction: either the run is fully computed or
  // nothing lands — no half-computed runs on crash. Upserts keep the retry
  // path idempotent inside the transaction as well.
  const payslipWrites: Array<Parameters<PayrollDbClient['payslip']['upsert']>[0]> = [];

  for (const emp of employees) {
    const assignment = emp.salaryStructures[0];
    if (!assignment) continue; // guarded by the query above; defensive only

    // Joiner/leaver proration (Phase 2 item 4; v4 fix #8 extends it to
    // mid-month leavers): the monthly base salary is scaled by calendar days
    // present. Assumption: FIXED components are NOT prorated (period
    // allowances); percentage components scale automatically because they
    // compute off the (prorated) base. Employees with zero days in the month
    // are excluded loudly, never paid zero.
    // Effective contract end for proration: contractEnd is the payroll-
    // driving "last paid day" (stamped on every exit transition); it falls
    // back to terminationDate for rows where only the exit event was
    // recorded (e.g. legacy/backfilled exits).
    const effectiveEnd = emp.contractEnd ?? emp.terminationDate ?? null;
    const present = daysPresentInMonth(emp.contractStart ?? null, effectiveEnd, year, month);
    if (present === 0) {
      exclude(emp, 'NOT_EMPLOYED_IN_PERIOD', 'contract does not cover the pay month');
      continue;
    }
    // Decimal end-to-end: the Prisma Decimal's canonical STRING crosses
    // into shared math — never Number(decimal). String-based minor-unit
    // conversion keeps it exact.
    const fullBase = assignment.baseSalary.toString();
    let baseSalaryInput: string | number = fullBase;
    if (present < dim) {
      baseSalaryInput = prorateByCalendarDays(Number(fullBase), present, year, month, currency);
      log.info('payroll.compute.prorated', {
        jobId: job.id,
        payrollRunId,
        employeeId: emp.id,
        daysPresent: present,
        daysInMonth: dim,
      });
    }

    const components: SalaryComponentInput[] = assignment.salaryStructure.components.map(
      (c: { name: string; type: string; calculationType: string; value: unknown }) => ({
        name: c.name,
        type: c.type as SalaryComponentInput['type'],
        calculationType: c.calculationType as SalaryComponentInput['calculationType'],
        value: String(c.value),
      }),
    );

    // Canonical shared computation (minor-unit exact, currency-aware).
    let payslip = computePayslip({ currency, baseSalary: baseSalaryInput, components });

    // Unpaid-leave deduction (Phase 2 item 4): approved leave in the month
    // on a LeaveType with isPaid=false deducts at the daily rate
    // (prorated base ÷ calendar days in the month — documented assumption).
    const unpaidDays = await fetchUnpaidLeaveDays(db, emp.id, year, month);
    if (unpaidDays > 0) {
      const baseMinor = toMinorUnits(baseSalaryInput, currency);
      const deductionMinor = Math.round(Math.round(baseMinor / dim) * unpaidDays);
      payslip = applyAdditionalDeductions(
        payslip,
        [
          {
            name: `Unpaid Leave (${unpaidDays} day${unpaidDays === 1 ? '' : 's'})`,
            amountMinor: deductionMinor,
          },
        ],
        currency,
      );
      log.info('payroll.compute.unpaid-leave', {
        jobId: job.id,
        payrollRunId,
        employeeId: emp.id,
        unpaidDays,
      });
    }

    payslipWrites.push({
      where: { payrollRunId_employeeId: { payrollRunId, employeeId: emp.id } },
      update: {
        grossPay: payslip.grossPay,
        totalDeductions: payslip.totalDeductions,
        netPay: payslip.netPay,
        breakdown: payslip.breakdown as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
      create: {
        payrollRunId,
        employeeId: emp.id,
        grossPay: payslip.grossPay,
        totalDeductions: payslip.totalDeductions,
        netPay: payslip.netPay,
        breakdown: payslip.breakdown as unknown as Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });

    totalGrossMinor += toMinorUnits(payslip.grossPay, currency);
    totalDeductionsMinor += toMinorUnits(payslip.totalDeductions, currency);
    totalNetMinor += toMinorUnits(payslip.netPay, currency);
    computed++;
    await job.updateProgress(Math.round((computed / employees.length) * 90));
  }

  await db.$transaction([
    ...payslipWrites.map((args) => db.payslip.upsert(args)),
    db.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        status: 'DRAFT',
        totalGross: fromMinorUnits(totalGrossMinor, currency),
        totalDeductions: fromMinorUnits(totalDeductionsMinor, currency),
        totalNet: fromMinorUnits(totalNetMinor, currency),
        // v4 fix #8: exclusion warnings are part of the run record, surfaced
        // via the payroll-runs API alongside the payslips.
        warnings,
        processedAt: new Date(),
      },
    }),
  ]);
  // Re-read the committed run for the response (the transaction array's last
  // element is the run update, but its union type is awkward to narrow).
  const updated = await db.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } });

  await job.updateProgress(100);
  log.info('payroll.compute.done', {
    jobId: job.id,
    payrollRunId,
    payslips: computed,
    excluded: warnings.length,
    totalGross: Number(updated.totalGross),
    totalNet: Number(updated.totalNet),
    correlationId,
  });

  return {
    success: true,
    payrollRunId,
    payslipsComputed: computed,
    warnings,
    totalGross: Number(updated.totalGross),
    totalDeductions: Number(updated.totalDeductions),
    totalNet: Number(updated.totalNet),
  };
}
