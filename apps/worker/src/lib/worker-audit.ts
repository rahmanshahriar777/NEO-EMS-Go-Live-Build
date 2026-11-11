import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@ems/database';
import type { AuditAction } from '@ems/shared';

const GENESIS_HASH = 'GENESIS';
const CURRENT_SCHEME_VERSION = 2;

const DEFAULT_PII_MASK_KEYS = [
  'salary',
  'baseSalary',
  'grossPay',
  'netPay',
  'totalDeductions',
  'bankAccount',
  'bankAccountEnc',
  'taxId',
  'taxIdEnc',
  'niNumber',
  'nationalId',
  'passport',
  'ssn',
  'password',
  'passwordHash',
  'secret',
  'emergencyContact',
  'gpsLatitude',
  'gpsLongitude',
];

const MASKED = '[REDACTED]';

function canonicalize(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return JSON.stringify(value);
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function maskPii(value: any): any {
  const extra = (process.env.AUDIT_PII_MASK_KEYS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const keys = [...DEFAULT_PII_MASK_KEYS.map((k) => k.toLowerCase()), ...extra];

  const recur = (v: any): any => {
    if (v === null || v === undefined || v instanceof Date) return v;
    if (Array.isArray(v)) return v.map((item) => recur(item));
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      const out: Record<string, any> = {};
      for (const k of Object.keys(v)) {
        out[k] = keys.some((p) => k.toLowerCase().includes(p)) ? MASKED : recur(v[k]);
      }
      return out;
    }
    return v;
  };

  return recur(value);
}

function canonicalAuditPayload(fields: {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string | null;
  createdAt: string;
}): string {
  return canonicalize({
    actorId: fields.actorId ?? null,
    actorEmail: fields.actorEmail ?? null,
    action: fields.action,
    entityType: fields.entityType,
    entityId: fields.entityId,
    beforeState: fields.beforeState ?? null,
    afterState: fields.afterState ?? null,
    ipAddress: fields.ipAddress ?? null,
    createdAt: fields.createdAt,
  });
}

function computeAuditHash(prevHash: string, canonicalPayload: string): string {
  return createHash('sha256').update(prevHash + canonicalPayload, 'utf8').digest('hex');
}

export interface WorkerAuditInput {
  actorId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string | null;
}

/**
 * Appends a hash-chained v2 row to `audit_logs` using the same advisory lock
 * and canonical hashing scheme as `AuditService` in `apps/api`.
 */
export async function appendWorkerAuditLog(
  input: WorkerAuditInput,
  clientOverride?: typeof prisma,
): Promise<string> {
  const client = clientOverride ?? prisma;
  const createdAt = new Date();
  const beforeState = input.beforeState !== undefined ? maskPii(input.beforeState) : null;
  const afterState = input.afterState !== undefined ? maskPii(input.afterState) : null;

  const payload = canonicalAuditPayload({
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeState,
    afterState,
    ipAddress: input.ipAddress ?? null,
    createdAt: createdAt.toISOString(),
  });

  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(420001, 7)::text`;

    const latest = await tx.$queryRaw<
      Array<{ id: string; hash: string | null; sequence: number | null; schemeVersion: number | null }>
    >`
      SELECT id, hash, "sequence", "schemeVersion"
      FROM audit_logs
      ORDER BY "sequence" DESC NULLS LAST, "createdAt" DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `;

    let prevHash = GENESIS_HASH;
    let nextSequence = 1;
    if (latest.length > 0) {
      const head = latest[0];
      prevHash = head.hash ?? GENESIS_HASH;
      nextSequence = (head.sequence ?? 0) + 1;

      if ((head.schemeVersion ?? 1) < CURRENT_SCHEME_VERSION) {
        const checkpointAfterState = {
          schemeVersion: CURRENT_SCHEME_VERSION,
          previousHeadHash: prevHash,
        };
        const checkpointPayload = canonicalAuditPayload({
          action: 'UPDATE',
          entityType: 'AUDIT_CHAIN',
          entityId: 'scheme-v2-checkpoint',
          beforeState: null,
          afterState: checkpointAfterState,
          ipAddress: null,
          createdAt: createdAt.toISOString(),
        });
        const checkpointHash = computeAuditHash(prevHash, checkpointPayload);
        const checkpointId = randomUUID();
        await tx.$queryRaw`
          INSERT INTO audit_logs
            ("entityType", "entityId", action, "beforeState", "afterState",
             "prevHash", hash, "createdAt", "sequence", "schemeVersion", id)
          VALUES (
            'AUDIT_CHAIN', 'scheme-v2-checkpoint', 'UPDATE'::"AuditAction",
            NULL, ${JSON.stringify(checkpointAfterState)}::jsonb,
            ${prevHash}, ${checkpointHash}, ${createdAt.toISOString()}::timestamp,
            ${nextSequence}, ${CURRENT_SCHEME_VERSION}, ${checkpointId}
          )
        `;
        prevHash = checkpointHash;
        nextSequence += 1;
      }
    }

    const hash = computeAuditHash(prevHash, payload);
    const rowId = randomUUID();
    await tx.$queryRaw`
      INSERT INTO audit_logs
        ("actorId", "actorEmail", action, "entityType", "entityId",
         "beforeState", "afterState", "ipAddress",
         "prevHash", hash, "createdAt", "sequence", "schemeVersion", id)
      VALUES (
        ${input.actorId ?? null}, ${input.actorEmail ?? null}, ${input.action}::"AuditAction",
        ${input.entityType}, ${input.entityId},
        ${beforeState ? JSON.stringify(beforeState) : null}::jsonb,
        ${afterState ? JSON.stringify(afterState) : null}::jsonb,
        ${input.ipAddress ?? null},
        ${prevHash}, ${hash}, ${createdAt.toISOString()}::timestamp,
        ${nextSequence}, ${CURRENT_SCHEME_VERSION}, ${rowId}
      )
    `;

    return rowId;
  });
}

