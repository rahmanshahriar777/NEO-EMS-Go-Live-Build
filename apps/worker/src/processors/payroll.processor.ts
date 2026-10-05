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
 * Eligibility (go-live Phase 1 item 2): non-deleted employees whose
 * employment status is payable — FULL_TIME, PART_TIME, CONTRACT, PROBATION,
 * INTERN — with an active salary structure. TERMINATED / RESIGNED are
 * excluded. Runs scoped to a department only cover that department;
 * company-wide runs (departmentId null) cover everyone.
 */

/**
 * Employment statuses that earn pay. Everything else (TERMINATED, RESIGNED,
 * …) is excluded from payroll runs. Exported for unit tests.
 */
export const PAYABLE_EMPLOYMENT_STATUSES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'PROBATION',
  'INTERN',
] as const;

/** Prisma `where` for payroll eligibility — pure, unit-tested. */
export function buildEligibilityWhere(run: { departmentId?: string | null }) {
  return {
    deletedAt: null,
    status: { in: [...PAYABLE_EMPLOYMENT_STATUSES] },
    ...(run.departmentId ? { departmentId: run.departmentId } : {}),
    salaryStructures: { some: { isActive: true } },
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

export async function processPayroll(job: Job<PayrollJobPayload>) {
  const { payrollRunId, correlationId } = job.data;
  log.info('payroll.compute.start', { jobId: job.id, payrollRunId, correlationId });

  const run = await prisma.payrollRun.findUnique({ where: { id: payrollRunId } });
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
    await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: 'PROCESSING' },
    });
  } else {
    log.info('payroll.compute.resume', { jobId: job.id, payrollRunId, status: run.status });
  }

  const employees = await fetchEligibleEmployees(prisma, run);

  if (employees.length === 0) {
    await prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: 'DRAFT' },
    });
    throw new Error(`No eligible employees with active salary structures for run ${payrollRunId}.`);
  }

  // Minor-unit exact totals (currency-aware — correct for JPY/KWD, not just
  // 2-decimal currencies). No `Math.round(x * 100)` float boundary.
  const currency = (run as { currency?: string | null }).currency ?? 'GBP';
  const { year, month } = run;
  const dim = daysInMonth(year, month);

  let totalGrossMinor = 0;
  let totalDeductionsMinor = 0;
  let totalNetMinor = 0;
  let computed = 0;

  // Compute every payslip first, then commit ALL writes (payslip upserts +
  // run totals) in a single transaction: either the run is fully computed or
  // nothing lands — no half-computed runs on crash. Upserts keep the retry
  // path idempotent inside the transaction as well.
  const payslipWrites: Array<Parameters<typeof prisma.payslip.upsert>[0]> = [];

  for (const emp of employees) {
    const assignment = emp.salaryStructures[0];
    if (!assignment) continue; // guarded by the query above; defensive only

    // Joiner/leaver proration (Phase 2 item 4): the monthly base salary is
    // scaled by calendar days present. Assumption: FIXED components are NOT
    // prorated (period allowances); percentage components scale automatically
    // because they compute off the (prorated) base. Employees with zero days
    // in the month are skipped loudly, not paid zero.
    const present = daysPresentInMonth(emp.contractStart ?? null, emp.contractEnd ?? null, year, month);
    if (present === 0) {
      log.info('payroll.compute.skip-not-employed', {
        jobId: job.id,
        payrollRunId,
        employeeId: emp.id,
        reason: 'contract does not cover the pay month',
      });
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
    const unpaidDays = await fetchUnpaidLeaveDays(prisma, emp.id, year, month);
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

  await prisma.$transaction([
    ...payslipWrites.map((args) => prisma.payslip.upsert(args)),
    prisma.payrollRun.update({
      where: { id: payrollRunId },
      data: {
        status: 'DRAFT',
        totalGross: fromMinorUnits(totalGrossMinor, currency),
        totalDeductions: fromMinorUnits(totalDeductionsMinor, currency),
        totalNet: fromMinorUnits(totalNetMinor, currency),
        processedAt: new Date(),
      },
    }),
  ]);
  // Re-read the committed run for the response (the transaction array's last
  // element is the run update, but its union type is awkward to narrow).
  const updated = await prisma.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } });

  await job.updateProgress(100);
  log.info('payroll.compute.done', {
    jobId: job.id,
    payrollRunId,
    payslips: computed,
    totalGross: Number(updated.totalGross),
    totalNet: Number(updated.totalNet),
    correlationId,
  });

  return {
    success: true,
    payrollRunId,
    payslipsComputed: computed,
    totalGross: Number(updated.totalGross),
    totalDeductions: Number(updated.totalDeductions),
    totalNet: Number(updated.totalNet),
  };
}
