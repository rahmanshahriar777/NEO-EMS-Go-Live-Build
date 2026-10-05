/**
 * Unit tests for the payroll processor's eligibility, proration, and
 * unpaid-leave helpers (go-live Phase 1 item 2, Phase 2 item 4).
 *
 * Prisma is mocked: fetchEligibleEmployees / fetchUnpaidLeaveDays take the
 * client as a parameter, so the tests assert the exact query shape without
 * a database.
 * Run with: tsx --test src/processors/payroll.processor.test.ts
 */
import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYABLE_EMPLOYMENT_STATUSES,
  EXITED_EMPLOYMENT_STATUSES,
  buildEligibilityWhere,
  classifyEligibility,
  daysPresentInMonth,
  fetchEligibleEmployees,
  fetchUnpaidLeaveDays,
  payMonthBounds,
  processPayroll,
  computePayrollRun,
} from './payroll.processor.js';
import { log } from '../logger.js';

const PAYABLE = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'PROBATION', 'INTERN'] as const;

describe('payroll eligibility (go-live Phase 1 item 2)', () => {
  for (const status of PAYABLE) {
    test(`${status} is a payable employment status`, () => {
      assert.ok(
        (PAYABLE_EMPLOYMENT_STATUSES as readonly string[]).includes(status),
        `${status} missing from PAYABLE_EMPLOYMENT_STATUSES`,
      );
      const where = buildEligibilityWhere({ departmentId: null }) as any;
      assert.deepEqual(where.status, {
        in: [...PAYABLE_EMPLOYMENT_STATUSES, ...EXITED_EMPLOYMENT_STATUSES],
      });
      assert.ok(where.status.in.includes(status));
    });
  }

  test('TERMINATED and RESIGNED are fetched so in-month leavers get final pay (v4 #8)', () => {
    const where = buildEligibilityWhere({ departmentId: null }) as any;
    assert.ok(where.status.in.includes('TERMINATED'));
    assert.ok(where.status.in.includes('RESIGNED'));
    assert.deepEqual(where.status.in, [
      ...PAYABLE_EMPLOYMENT_STATUSES,
      ...EXITED_EMPLOYMENT_STATUSES,
    ]);
  });

  test('fetchEligibleEmployees queries with the payable + exited status set (mocked Prisma)', async () => {
    const seen: any[] = [];
    const mock = {
      employee: {
        findMany: async (args: any) => {
          seen.push(args);
          return [];
        },
      },
    };
    await fetchEligibleEmployees(mock, { departmentId: null });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].where.status, {
      in: [...PAYABLE_EMPLOYMENT_STATUSES, ...EXITED_EMPLOYMENT_STATUSES],
    });
    assert.equal(seen[0].where.deletedAt, null);
    assert.deepEqual(seen[0].where.salaryStructures, { some: { isActive: true } });
  });

  test('department scoping is preserved when the run is department-scoped', async () => {
    const seen: any[] = [];
    const mock = {
      employee: {
        findMany: async (args: any) => {
          seen.push(args);
          return [];
        },
      },
    };
    await fetchEligibleEmployees(mock, { departmentId: 'dept-1' });
    assert.equal(seen[0].where.departmentId, 'dept-1');
  });
});

describe('daysPresentInMonth (joiner/leaver proration)', () => {
  test('no contract bounds → full month', () => {
    assert.equal(daysPresentInMonth(null, null, 2026, 10), 31);
    assert.equal(daysPresentInMonth(undefined, undefined, 2026, 2), 28);
  });

  test('joiner mid-month → days from contractStart', () => {
    // Joined 2026-10-15 → 17 days present in October.
    assert.equal(daysPresentInMonth(new Date('2026-10-15T00:00:00Z'), null, 2026, 10), 17);
  });

  test('leaver mid-month → days up to contractEnd', () => {
    // Left 2026-10-10 → 10 days present in October.
    assert.equal(daysPresentInMonth(null, new Date('2026-10-10T00:00:00Z'), 2026, 10), 10);
  });

  test('contract entirely outside the month → 0 days', () => {
    assert.equal(
      daysPresentInMonth(new Date('2026-11-01T00:00:00Z'), null, 2026, 10),
      0,
    );
    assert.equal(
      daysPresentInMonth(null, new Date('2026-09-30T00:00:00Z'), 2026, 10),
      0,
    );
  });
});

describe('fetchUnpaidLeaveDays (unpaid leave deduction)', () => {
  const rows = (rs: any[]) => ({
    leaveRequest: { findMany: async () => rs },
  });

  test('sums calendar-day overlap of unpaid approved leave only', async () => {
    // Note: the isPaid=false filter lives in the Prisma where clause (asserted
    // below), so the mock only returns rows the DB would return.
    const days = await fetchUnpaidLeaveDays(
      rows([
        {
          startDate: new Date('2026-09-29T00:00:00Z'),
          endDate: new Date('2026-10-02T00:00:00Z'),
          halfDay: false,
        },
        {
          startDate: new Date('2026-10-25T00:00:00Z'),
          endDate: new Date('2026-10-25T00:00:00Z'),
          halfDay: true, // half-day → 0.5
        },
      ]),
      'emp-1',
      2026,
      10,
    );
    assert.equal(days, 2 + 0.5);
  });

  test('queries only APPROVED unpaid requests overlapping the pay month', async () => {
    const seen: any[] = [];
    const mock = {
      leaveRequest: {
        findMany: async (args: any) => {
          seen.push(args);
          return [];
        },
      },
    };
    await fetchUnpaidLeaveDays(mock, 'emp-9', 2026, 10);
    const where = seen[0].where;
    assert.equal(where.employeeId, 'emp-9');
    assert.equal(where.status, 'APPROVED');
    assert.deepEqual(where.leaveType, { isPaid: false });
    assert.ok(where.startDate.lte instanceof Date);
    assert.ok(where.endDate.gte instanceof Date);
  });
});

describe('classifyEligibility (v4 fix #8 — leaver final pay)', () => {
  test('payable statuses are always eligible', () => {
    for (const status of PAYABLE_EMPLOYMENT_STATUSES) {
      const d = classifyEligibility({ status }, 2026, 10);
      assert.equal(d.eligible, true, status);
    }
  });

  test('TERMINATED with contractEnd inside the pay month → eligible', () => {
    const d = classifyEligibility(
      { status: 'TERMINATED', contractEnd: new Date('2026-10-10T00:00:00Z') },
      2026,
      10,
    );
    assert.equal(d.eligible, true);
  });

  test('RESIGNED with only terminationDate inside the pay month → eligible', () => {
    const d = classifyEligibility(
      { status: 'RESIGNED', terminationDate: new Date('2026-10-31T23:59:59Z') },
      2026,
      10,
    );
    assert.equal(d.eligible, true);
  });

  test('leaver who exited before the pay month → excluded, loud reason', () => {
    const d = classifyEligibility(
      { status: 'TERMINATED', contractEnd: new Date('2026-09-30T00:00:00Z') },
      2026,
      10,
    );
    assert.equal(d.eligible, false);
    assert.equal(d.code, 'TERMINATED_BEFORE_PERIOD');
    assert.match(d.reason as string, /before the pay period/);
  });

  test('leaver with no exit date at all → excluded, TERMINATION_DATE_MISSING', () => {
    const d = classifyEligibility({ status: 'RESIGNED' }, 2026, 10);
    assert.equal(d.eligible, false);
    assert.equal(d.code, 'TERMINATION_DATE_MISSING');
    assert.match(d.reason as string, /termination date/i);
  });

  test('payMonthBounds covers the full calendar month in UTC', () => {
    const { start, end } = payMonthBounds(2026, 10);
    assert.equal(start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-31T23:59:59.999Z');
  });
});

describe('processPayroll leavers + loud exclusions (v4 fix #8)', () => {
  const runRow = (overrides: Record<string, any> = {}) => ({
    id: 'run-1',
    status: 'DRAFT',
    year: 2026,
    month: 10,
    currency: 'GBP',
    departmentId: null,
    totalGross: '0',
    totalDeductions: '0',
    totalNet: '0',
    ...overrides,
  });

  const empRow = (overrides: Record<string, any> = {}) => ({
    id: 'emp-1',
    employeeNumber: 'EMP-2026-0001',
    email: 'a@ems.local',
    status: 'FULL_TIME',
    contractStart: null,
    contractEnd: null,
    terminationDate: null,
    salaryStructures: [
      {
        // Prisma Decimal stand-in: only .toString() is used (never Number()).
        baseSalary: { toString: () => '3000' },
        salaryStructure: { components: [] },
      },
    ],
    ...overrides,
  });

  const mockDb = (employees: any[]) => {
    const run = runRow();
    const payslipUpserts: any[] = [];
    const runUpdates: any[] = [];
    const db: any = {
      payrollRun: {
        findUnique: async () => ({ ...run }),
        findUniqueOrThrow: async () => ({ ...run }),
        update: async (args: any) => {
          runUpdates.push(args);
          Object.assign(run, args.data);
          return { ...run };
        },
      },
      employee: { findMany: async () => employees },
      leaveRequest: { findMany: async () => [] },
      payslip: {
        upsert: (args: any) => {
          payslipUpserts.push(args);
          return args;
        },
      },
      $transaction: async (ops: any[]) => ops,
    };
    return { db, payslipUpserts, runUpdates, run };
  };

  const job: any = {
    id: 'job-1',
    data: { payrollRunId: 'run-1', correlationId: 'corr-1' },
    updateProgress: async () => {},
  };

  test('leaver terminated mid-month gets prorated final pay, not $0', async () => {
    // Left 2026-10-10 → 10 of 31 days; base 3100 GBP → exactly 1000.
    const leaver = empRow({
      id: 'emp-leaver',
      status: 'TERMINATED',
      contractEnd: new Date('2026-10-10T00:00:00Z'),
      terminationDate: new Date('2026-10-10T00:00:00Z'),
      salaryStructures: [
        {
          baseSalary: { toString: () => '3100' },
          salaryStructure: { components: [] },
        },
      ],
    });
    const { db, payslipUpserts } = mockDb([leaver]);

    const result: any = await computePayrollRun(job, db);

    assert.equal(result.payslipsComputed, 1);
    assert.equal(payslipUpserts.length, 1);
    assert.equal(payslipUpserts[0].create.employeeId, 'emp-leaver');
    assert.equal(payslipUpserts[0].create.grossPay, 1000);
    assert.equal(payslipUpserts[0].create.netPay, 1000);
    assert.deepEqual(result.warnings, []);
  });

  test('full-month employee is unaffected (no proration, no warnings)', async () => {
    const full = empRow({ id: 'emp-full' });
    const { db, payslipUpserts } = mockDb([full]);

    const result: any = await computePayrollRun(job, db);

    assert.equal(result.payslipsComputed, 1);
    assert.equal(payslipUpserts[0].create.grossPay, 3000);
    assert.equal(payslipUpserts[0].create.netPay, 3000);
    assert.deepEqual(result.warnings, []);
  });

  test('excluded employee → loud warning in logs, run record, and result', async (t) => {
    const warnSpy = mock.method(log, 'warn');
    t.after(() => warnSpy.mock.restore());

    const ghost = empRow({
      id: 'emp-ghost',
      employeeNumber: 'EMP-2026-0009',
      status: 'TERMINATED', // exited, but nobody recorded the date
    });
    const { db, runUpdates } = mockDb([ghost]);

    await assert.rejects(() => computePayrollRun(job, db), /No eligible employees/);

    // 1. structured warn log (loud, not silent)
    const warnCalls = warnSpy.mock.calls.filter((c) => c.arguments[0] === 'payroll.compute.excluded');
    assert.equal(warnCalls.length, 1);
    assert.equal(warnCalls[0].arguments[1].code, 'TERMINATION_DATE_MISSING');
    assert.equal(warnCalls[0].arguments[1].employeeId, 'emp-ghost');

    // 2. persisted on the run (surfaced via GET /payroll/runs/:id)
    const finalUpdate = runUpdates[runUpdates.length - 1];
    assert.ok(Array.isArray(finalUpdate.data.warnings));
    assert.equal(finalUpdate.data.warnings.length, 1);
    assert.equal(finalUpdate.data.warnings[0].code, 'TERMINATION_DATE_MISSING');
    assert.match(finalUpdate.data.warnings[0].reason, /termination date/i);
  });

  test('mixed run: leaver paid pro-rata, pre-period leaver warned, totals exact', async () => {
    const full = empRow({ id: 'emp-full' });
    const leaver = empRow({
      id: 'emp-leaver',
      employeeNumber: 'EMP-2026-0002',
      status: 'RESIGNED',
      contractEnd: new Date('2026-10-10T00:00:00Z'),
      salaryStructures: [
        { baseSalary: { toString: () => '3100' }, salaryStructure: { components: [] } },
      ],
    });
    const oldLeaver = empRow({
      id: 'emp-old',
      employeeNumber: 'EMP-2026-0003',
      status: 'TERMINATED',
      contractEnd: new Date('2026-08-15T00:00:00Z'),
    });
    const { db, payslipUpserts, runUpdates } = mockDb([full, leaver, oldLeaver]);

    const result: any = await computePayrollRun(job, db);

    assert.equal(result.payslipsComputed, 2);
    assert.equal(payslipUpserts.length, 2);
    // totals: 3000 + 1000 = 4000 (minor-unit exact, no float boundary)
    assert.equal(result.totalGross, 4000);
    assert.equal(result.totalNet, 4000);
    // one loud warning for the pre-period leaver
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'TERMINATED_BEFORE_PERIOD');
    assert.equal(result.warnings[0].employeeId, 'emp-old');
    const finalUpdate = runUpdates[runUpdates.length - 1];
    assert.equal(finalUpdate.data.warnings.length, 1);
  });
});
