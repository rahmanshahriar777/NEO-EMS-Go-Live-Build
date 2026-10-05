/**
 * Unit tests for the payroll processor's eligibility, proration, and
 * unpaid-leave helpers (go-live Phase 1 item 2, Phase 2 item 4).
 *
 * Prisma is mocked: fetchEligibleEmployees / fetchUnpaidLeaveDays take the
 * client as a parameter, so the tests assert the exact query shape without
 * a database.
 * Run with: tsx --test src/processors/payroll.processor.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYABLE_EMPLOYMENT_STATUSES,
  buildEligibilityWhere,
  daysPresentInMonth,
  fetchEligibleEmployees,
  fetchUnpaidLeaveDays,
} from './payroll.processor.js';

const PAYABLE = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'PROBATION', 'INTERN'] as const;

describe('payroll eligibility (go-live Phase 1 item 2)', () => {
  for (const status of PAYABLE) {
    test(`${status} is a payable employment status`, () => {
      assert.ok(
        (PAYABLE_EMPLOYMENT_STATUSES as readonly string[]).includes(status),
        `${status} missing from PAYABLE_EMPLOYMENT_STATUSES`,
      );
      const where = buildEligibilityWhere({ departmentId: null }) as any;
      assert.deepEqual(where.status, { in: [...PAYABLE_EMPLOYMENT_STATUSES] });
      assert.ok(where.status.in.includes(status));
    });
  }

  test('TERMINATED and RESIGNED are excluded from payroll', () => {
    const where = buildEligibilityWhere({ departmentId: null }) as any;
    assert.ok(!where.status.in.includes('TERMINATED'));
    assert.ok(!where.status.in.includes('RESIGNED'));
  });

  test('fetchEligibleEmployees queries with the payable status set (mocked Prisma)', async () => {
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
    assert.deepEqual(seen[0].where.status, { in: [...PAYABLE_EMPLOYMENT_STATUSES] });
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
