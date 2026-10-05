import { Job } from 'bullmq';
import { prisma } from '@ems/database';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { log } from '../logger.js';

/**
 * Monthly leave accrual (Phase 3 item 1, go-live hardening).
 *
 * For every LeavePolicy with `accrualPerMonth` set, credits each active
 * (non-deleted) employee's LeaveBalance for that leave type:
 *   allocatedDays += accrual, remainingDays += accrual
 * for the current calendar year. Balances are upserted on the
 * @@unique([employeeId, leaveTypeId, year]) key, so a fresh year starts clean.
 *
 * IDEMPOTENCY ("credit once per month"):
 * - A completion marker `ems:accrual:leave:<year>:<month>` is set ONLY after
 *   the full pass succeeds (TTL 62 days). A repeat fire in the same month
 *   short-circuits.
 * - A per-employee done-set `<marker>:done` records each credited
 *   (employeeId, leaveTypeId) pair. If BullMQ retries a partially completed
 *   run, already-credited employees are skipped — no double credit.
 *
 * ASSUMPTIONS (documented):
 * - Accrual applies to all non-deleted employees regardless of employment
 *   status; per-status/per-policy scoping is a future enhancement.
 * - LeaveBalance is Decimal(5,1): fractional monthly accruals (e.g. 1.67)
 *   are rounded by Postgres to 1 decimal on write.
 * - A policy added mid-month takes effect from the NEXT monthly run (the
 *   completion marker is per month, not per policy).
 */

const ACCRUAL_KEY_PREFIX = 'ems:accrual:leave:';
const MARKER_TTL_SECONDS = 62 * 86400;
const EMPLOYEE_BATCH_SIZE = 500;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
  }
  return redis;
}

/**
 * Credit one employee's balance for one leave type. Atomic upsert: insert
 * the year's row, or add the accrual to the existing row's allocated and
 * remaining days.
 */
async function creditAccrual(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  accrual: number,
): Promise<void> {
  await prisma.$queryRaw`
    INSERT INTO leave_balances
      (id, "employeeId", "leaveTypeId", year, "allocatedDays", "usedDays", "pendingDays", "remainingDays", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${employeeId}, ${leaveTypeId}, ${year}, ${accrual}, 0, 0, ${accrual}, now(), now())
    ON CONFLICT ("employeeId", "leaveTypeId", year)
    DO UPDATE SET
      "allocatedDays" = leave_balances."allocatedDays" + ${accrual},
      "remainingDays" = leave_balances."remainingDays" + ${accrual},
      "updatedAt" = now()
  `;
}

export async function accrueMonthlyLeave(job: Job<{ correlationId?: string }>) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  const correlationId = job.data.correlationId ?? `accrual:${year}-${String(month).padStart(2, '0')}`;
  const markerKey = `${ACCRUAL_KEY_PREFIX}${year}:${String(month).padStart(2, '0')}`;
  const doneKey = `${markerKey}:done`;

  const r = getRedis();
  if ((await r.exists(markerKey)) === 1) {
    log.info('leave-accrual.skip', {
      jobId: job.id,
      year,
      month,
      reason: 'completion marker present — already accrued this month',
      correlationId,
    });
    return { operation: 'accrueMonthlyLeave', skipped: true, year, month };
  }

  const policies = await prisma.leavePolicy.findMany({
    where: { accrualPerMonth: { not: null } },
    select: {
      leaveTypeId: true,
      accrualPerMonth: true,
      leaveType: { select: { name: true } },
    },
  });
  const active = policies.filter(
    (p) => p.accrualPerMonth !== null && Number(p.accrualPerMonth) > 0,
  );

  log.info('leave-accrual.start', {
    jobId: job.id,
    year,
    month,
    policies: active.length,
    correlationId,
  });

  let credited = 0;
  let skipped = 0;

  for (const policy of active) {
    const accrual = Number(policy.accrualPerMonth);
    // Cursor-paginate employees (opaque uuid ordering, full coverage).
    let cursor: string | undefined;
    for (;;) {
      const employees = await prisma.employee.findMany({
        where: {
          deletedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: EMPLOYEE_BATCH_SIZE,
      });
      if (employees.length === 0) break;

      for (const emp of employees) {
        const member = `${emp.id}:${policy.leaveTypeId}`;
        if ((await r.sismember(doneKey, member)) === 1) {
          skipped++;
          continue;
        }
        await creditAccrual(emp.id, policy.leaveTypeId, year, accrual);
        await r.sadd(doneKey, member);
        credited++;
      }
      cursor = employees[employees.length - 1].id;
    }

    log.info('leave-accrual.policy-done', {
      jobId: job.id,
      leaveType: policy.leaveType.name,
      accrualPerMonth: accrual,
      correlationId,
    });
  }

  // Completion marker: only now is the month "done". Done-set expires with it.
  await r.set(markerKey, new Date().toISOString(), 'EX', MARKER_TTL_SECONDS);
  await r.expire(doneKey, MARKER_TTL_SECONDS);

  log.info('leave-accrual.done', {
    jobId: job.id,
    year,
    month,
    credited,
    skipped,
    correlationId,
  });

  return { operation: 'accrueMonthlyLeave', year, month, credited, skipped };
}
