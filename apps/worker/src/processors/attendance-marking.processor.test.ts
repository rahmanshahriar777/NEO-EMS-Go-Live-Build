/**
 * Unit tests for the nightly absence-marking processor (mocked Prisma).
 *
 * Covers the DB-touching `markNightlyAbsences` (the pure date helper is
 * covered by attendance.processor.test.ts):
 * - eligibility filter: non-deleted, TERMINATED/RESIGNED excluded,
 * - grouping by entity timezone,
 * - excuses: existing attendance record (any status), approved leave covering
 *   the date, company holiday on the date,
 * - idempotency: createMany with skipDuplicates so a retried or overlapping
 *   run converges instead of double-marking,
 * - empty employee list: no-op, no DB writes.
 *
 * Run: npx tsx --test src/processors/attendance.processor.unit.spec.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@ems/database';
import {
  markNightlyAbsences,
  targetDateForTimezone,
  AUTO_ABSENT_NOTE,
} from './attendance.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';

const job = (data: any = {}) => ({ id: 'job-a1', data } as any);

const expectedDate = (tz: string): Date =>
  new Date(`${targetDateForTimezone(tz)}T00:00:00Z`);

describe('markNightlyAbsences', () => {
  test('no eligible employees: no-op, no writes', async (t) => {
    const findMany = stubPrisma(prisma.employee, 'findMany', async () => [], t);
    const createMany = stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 0 }), t);

    const out = await markNightlyAbsences(job());

    assert.equal(findMany.calls.length, 1);
    assert.deepEqual(out, { groups: [], totalChecked: 0, totalMarked: 0 });
    assert.equal(createMany.calls.length, 0);
  });

  test('eligibility: excludes deleted and TERMINATED/RESIGNED employees', async (t) => {
    const findMany = stubPrisma(prisma.employee, 'findMany', async () => [], t);
    stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 0 }), t);

    await markNightlyAbsences(job());

    const where = findMany.calls[0][0].where;
    assert.equal(where.deletedAt, null);
    assert.deepEqual(where.status, { notIn: ['TERMINATED', 'RESIGNED'] });
  });

  test('unexcused employee is marked ABSENT idempotently', async (t) => {
    stubPrisma(prisma.employee, 'findMany', async () => [
      { id: 'emp-1', entity: { timezone: 'UTC' } },
    ], t);
    stubPrisma(prisma.attendanceRecord, 'findMany', async () => [], t);
    stubPrisma(prisma.leaveRequest, 'findMany', async () => [], t);
    stubPrisma(prisma.holiday, 'findFirst', async () => null, t);
    const createMany = stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 1 }), t);

    const out = await markNightlyAbsences(job());

    assert.equal(createMany.calls.length, 1);
    const args = createMany.calls[0][0];
    assert.equal(args.skipDuplicates, true, 'idempotent: @@unique([employeeId, date]) + skipDuplicates');
    assert.deepEqual(args.data, [
      {
        employeeId: 'emp-1',
        date: expectedDate('UTC'),
        status: 'ABSENT',
        notes: AUTO_ABSENT_NOTE,
      },
    ]);
    assert.equal(out.totalChecked, 1);
    assert.equal(out.totalMarked, 1);
    assert.equal(out.groups[0].skipped, 0);
  });

  test('existing attendance record excuses the employee (any status)', async (t) => {
    stubPrisma(prisma.employee, 'findMany', async () => [
      { id: 'emp-1', entity: { timezone: 'UTC' } },
      { id: 'emp-2', entity: { timezone: 'UTC' } },
    ], t);
    // emp-1 clocked in (PRESENT); emp-2 did not.
    stubPrisma(prisma.attendanceRecord, 'findMany', async () => [{ employeeId: 'emp-1' }], t);
    stubPrisma(prisma.leaveRequest, 'findMany', async () => [], t);
    stubPrisma(prisma.holiday, 'findFirst', async () => null, t);
    const createMany = stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 1 }), t);

    const out = await markNightlyAbsences(job());

    const marked = createMany.calls[0][0].data.map((r: any) => r.employeeId);
    assert.deepEqual(marked, ['emp-2'], 'only the unexcused employee is marked');
    assert.equal(out.groups[0].checked, 2);
    assert.equal(out.groups[0].marked, 1);
    assert.equal(out.groups[0].skipped, 1);
  });

  test('approved leave covering the date excuses the employee', async (t) => {
    stubPrisma(prisma.employee, 'findMany', async () => [
      { id: 'emp-1', entity: { timezone: 'UTC' } },
    ], t);
    stubPrisma(prisma.attendanceRecord, 'findMany', async () => [], t);
    const leaveFind = stubPrisma(prisma.leaveRequest, 'findMany', async () => [{ employeeId: 'emp-1' }], t);
    stubPrisma(prisma.holiday, 'findFirst', async () => null, t);
    const createMany = stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 0 }), t);

    await markNightlyAbsences(job());

    const where = leaveFind.calls[0][0].where;
    assert.equal(where.status, 'APPROVED');
    assert.deepEqual(where.startDate, { lte: expectedDate('UTC') });
    assert.deepEqual(where.endDate, { gte: expectedDate('UTC') });
    assert.equal(createMany.calls.length, 0, 'approved leave excuses absence');
  });

  test('company holiday skips the whole group (no writes)', async (t) => {
    stubPrisma(prisma.employee, 'findMany', async () => [
      { id: 'emp-1', entity: { timezone: 'UTC' } },
      { id: 'emp-2', entity: { timezone: 'UTC' } },
    ], t);
    stubPrisma(prisma.attendanceRecord, 'findMany', async () => [], t);
    stubPrisma(prisma.leaveRequest, 'findMany', async () => [], t);
    stubPrisma(prisma.holiday, 'findFirst', async () => ({ id: 'hol-1' }), t);
    const createMany = stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 0 }), t);

    const out = await markNightlyAbsences(job());

    assert.equal(createMany.calls.length, 0, 'holiday suppresses marking for the group');
    assert.deepEqual(out.groups[0], {
      timezone: 'UTC',
      date: targetDateForTimezone('UTC'),
      checked: 2,
      marked: 0,
      skipped: 2,
    });
  });

  test('employees are grouped per entity timezone; missing timezone falls back to UTC', async (t) => {
    stubPrisma(prisma.employee, 'findMany', async () => [
      { id: 'emp-utc', entity: { timezone: 'UTC' } },
      { id: 'emp-dhaka', entity: { timezone: 'Asia/Dhaka' } },
      { id: 'emp-none', entity: null },
    ], t);
    const seenDates: Date[] = [];
    stubPrisma(prisma.attendanceRecord, 'findMany', async (args: any) => {
      seenDates.push(args.where.date);
      return [];
    }, t);
    stubPrisma(prisma.leaveRequest, 'findMany', async () => [], t);
    stubPrisma(prisma.holiday, 'findFirst', async () => null, t);
    stubPrisma(prisma.attendanceRecord, 'createMany', async () => ({ count: 1 }), t);

    const out = await markNightlyAbsences(job());

    assert.equal(out.groups.length, 2, 'UTC (+fallback) and Asia/Dhaka');
    const timezones = out.groups.map((g) => g.timezone).sort();
    assert.deepEqual(timezones, ['Asia/Dhaka', 'UTC']);
    assert.ok(
      seenDates.some((d) => d.getTime() === expectedDate('Asia/Dhaka').getTime()),
      'yesterday is computed in the entity timezone',
    );
  });
});
