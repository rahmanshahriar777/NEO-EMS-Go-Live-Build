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
 * REDIS (HIGH #4 fix): this processor reuses the worker's shared BullMQ
 * connection, injected once at boot via `setLeaveAccrualRedis()` (called
 * from main.ts). The old module-local client used `lazyConnect: true` and
 * never called `connect()` — with `enableOfflineQueue: false` every
 * command rejected, so every monthly run failed into the DLQ.
 *
 * DISTRIBUTED LOCK: a `<marker>:lock` key (SET NX EX 1h) wraps the accrual
 * pass so two worker replicas can never double-accrue the same month. The
 * lock holder crashing mid-pass is safe: the lock expires, and the
 * per-employee done-set makes a resumed pass skip already-credited rows.
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
const LOCK_TTL_SECONDS = 3600;
const EMPLOYEE_BATCH_SIZE = 500;

let redis: Redis | null = null;

/**
 * Inject the worker's shared Redis connection. MUST be called once at
 * worker boot (main.ts) before any accrual job can fire.
 */
export function setLeaveAccrualRedis(connection: Redis): void {
  redis = connection;
  log.info('leave-accrual.redis.injected', {});
}

/** Release the accrual lock only if we still hold it (compare-and-del). */
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

async function releaseAccrualLock(r: Redis, lockKey: string, token: string): Promise<void> {
  try {
    await r.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch (e: any) {
    // Best-effort: the lock TTL bounds the damage if this fails.
    log.warn('leave-accrual.lock-release-failed', { lockKey, error: e?.message });
  }
}

function getRedis(): Redis {
  if (redis) return redis;
  // Defensive fallback (main.ts always injects): a client that connects
  // EAGERLY — the old lazyConnect:true client that never connected is what
  // dead-lettered every accrual run (HIGH #4).
  log.warn('leave-accrual.redis.fallback', {
    reason: 'no shared connection injected; creating an eagerly-connected client',
  });
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
  });
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

  // Distributed lock (HIGH #4): two worker replicas must never accrue the
  // same month concurrently. SET NX EX — only the lock winner runs the
  // pass; the loser skips loudly (the monthly repeatable job fires once,
  // so a skip here means "already handled", not "lost").
  const lockKey = `${markerKey}:lock`;
  const lockToken = randomUUID();
  const acquired = await r.set(lockKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') {
    log.warn('leave-accrual.lock-skip', {
      jobId: job.id,
      year,
      month,
      lockKey,
      reason: 'another worker holds the accrual lock — skipping this run',
      correlationId,
    });
    return { operation: 'accrueMonthlyLeave', skipped: true, year, month, reason: 'lock-held' };
  }

  try {
    return await runAccrualPass(r, job, { year, month, markerKey, doneKey, correlationId });
  } finally {
    await releaseAccrualLock(r, lockKey, lockToken);
  }
}

/** The accrual pass itself. Runs only under the distributed lock. */
async function runAccrualPass(
  r: Redis,
  job: Job<{ correlationId?: string }>,
  ctx: { year: number; month: number; markerKey: string; doneKey: string; correlationId: string },
) {
  const { year, month, markerKey, doneKey, correlationId } = ctx;

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
