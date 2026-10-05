import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditAction,
  createPaginatedResponse,
  RETENTION_SIGNOFF_ENV,
  isRetentionSignedOff,
} from '@ems/shared';

export interface RecordAuditParams {
  actorId?: string;
  actorEmail?: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  checked: number;
  /** True when the chain starts mid-history because old rows were purged. */
  truncated?: boolean;
  failedAt?: { id: string; reason: string };
}

/** Minimal transaction-client surface the audit writer needs. */
export type AuditTxClient = {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: any[]) => Promise<T>;
  auditLog: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
  };
};

const GENESIS_HASH = 'GENESIS';

/** Current chain scheme. Rows written by this code are v2. */
const CURRENT_SCHEME_VERSION = 2;

/**
 * ASSUMPTION (retention): audit rows are retained for 7 years (2555 days),
 * the UK statutory ceiling for payroll-adjacent records (HMRC). Override
 * with AUDIT_RETENTION_DAYS. Counsel sign-off pending — see code comment in
 * purgeExpiredAuditLogs.
 */
const DEFAULT_RETENTION_DAYS = 2555;

/**
 * Keys whose values are replaced with '[REDACTED]' before hashing/storage.
 * Substring-matched, case-insensitive. Extend at runtime with
 * AUDIT_PII_MASK_KEYS="customField,anotherField".
 */
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
];

const MASKED = '[REDACTED]';

/**
 * Deterministic JSON serialisation: object keys sorted recursively so the
 * same logical payload always produces the same bytes (required for stable
 * hashing and for /audit/verify to recompute identical hashes).
 *
 * MONEY FIX (Phase 1 hardening): Prisma.Decimal (and any other non-plain
 * object) is serialised via JSON.stringify, which honours Decimal.toJSON()
 * and yields the canonical decimal STRING ("12.50") instead of recursing
 * into Decimal's internal fields (which produced unstable payloads and
 * broke verification for money-bearing rows).
 */
export function canonicalize(value: any): string {
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
      // Decimal, ObjectId, class instances, … → stable via toJSON().
      return JSON.stringify(value);
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeAuditHash(prevHash: string, canonicalPayload: string): string {
  return createHash('sha256').update(prevHash + canonicalPayload, 'utf8').digest('hex');
}

/**
 * Fields of the ONE hash-payload schema for the audit chain.
 * `createdAt` is an ISO-8601 string (not a Date) so the bytes being hashed
 * are identical at write time and at verification time.
 */
export interface AuditPayloadFields {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string | null;
  createdAt: string;
}

/**
 * CHECKPOINT SCHEMA (finding #6, release/v4-fixes — CHOSEN: option (b)).
 *
 * There is exactly ONE hash-payload schema for the whole chain: the 9
 * fields below, canonicalized by `canonicalize()`. Checkpoint rows (the
 * v1→v2 scheme transition emitted by insertV2, and the retention-truncation
 * checkpoints emitted by purgeExpiredAuditLogs) are ORDINARY rows hashed
 * in this SAME form — they carry no special hashing schema. A checkpoint
 * is recognizable by entityType='AUDIT_CHAIN' (entityId
 * 'scheme-v2-checkpoint' / 'retention-truncation'); the checkpoint
 * details live in afterState.
 *
 * Why (b) and not (a): the old special checkpoint schema had fields
 * (previousHeadSequence, emittedAt, checkpoint: '…') that are NOT all
 * stored in columns, so a verifier reproducing it would have to re-derive
 * them from fragile assumptions (sequence arithmetic, column re-reads).
 * One schema for writes AND verification removes that failure mode: every
 * writer below goes through this function, and both verifyChainV1/V2
 * recompute through it too.
 *
 * Any future checkpoint writer MUST build its payload through this
 * function, storing exactly the columns it hashed — otherwise verification
 * breaks at the checkpoint row.
 */
export function canonicalAuditPayload(fields: AuditPayloadFields): string {
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

function piiMaskKeys(): string[] {
  const extra = (process.env.AUDIT_PII_MASK_KEYS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_PII_MASK_KEYS.map((k) => k.toLowerCase()), ...extra];
}

/** Deep-clones `value`, replacing PII-keyed leaves with '[REDACTED]'. */
export function maskPii(value: any, keys: string[] = piiMaskKeys()): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => maskPii(v, keys));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      out[k] = keys.some((p) => k.toLowerCase().includes(p))
        ? MASKED
        : maskPii(value[k], keys);
    }
    return out;
  }
  return value;
}

/** Redacts PII values inside a field diff: { field: { before, after } }. */
function maskDiffValues(
  diff: Record<string, { before: any; after: any }>,
  keys: string[] = piiMaskKeys(),
): Record<string, { before: any; after: any }> {
  const out: Record<string, { before: any; after: any }> = {};
  for (const [field, change] of Object.entries(diff)) {
    if (keys.some((p) => field.toLowerCase().includes(p))) {
      out[field] = { before: MASKED, after: MASKED };
    } else {
      out[field] = { before: maskPii(change.before, keys), after: maskPii(change.after, keys) };
    }
  }
  return out;
}

function isPlainObject(v: any): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Field-level diff between two states: `{ field: { before, after } }`
 * for every top-level key whose canonical form changed. Nested objects are
 * compared as canonical JSON blobs (one entry per top-level key).
 * Callers mask the result with maskDiffValues() before storage.
 */
export function buildFieldDiff(before: any, after: any): Record<string, { before: any; after: any }> {
  const diff: Record<string, { before: any; after: any }> = {};
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const beforeCanon = canonicalize(b[key]);
    const afterCanon = canonicalize(a[key]);
    if (beforeCanon !== afterCanon) {
      diff[key] = { before: b[key] ?? null, after: a[key] ?? null };
    }
  }
  return diff;
}

/** True when a raw-query error means "the v2 columns are not migrated yet". */
function isMissingColumnError(error: any): boolean {
  const msg = String(error?.message || error || '');
  return /42703|undefined_column|does not exist/i.test(msg);
}

/**
 * Tamper-EVIDENT (not tamper-proof) audit log (F18).
 *
 * Chain scheme v2 (Phase 1 hardening):
 * - `sequence` (unique, gapless per writer) + `schemeVersion` columns.
 *   Existing rows are v1 (backfilled to schemeVersion=1 by migration);
 *   the first v2 write emits a checkpoint row, then continues at v2.
 * - The chain head is locked with a Postgres advisory transaction lock
 *   (pg_advisory_xact_lock) so concurrent writers serialise instead of
 *   racing on the latest row.
 * - Payloads are canonicalized to plain JSON BEFORE hashing; Prisma.Decimal
 *   values hash as their canonical decimal strings.
 * - PII/salary fields are masked before hashing/storage; a field-level diff
 *   is stored under `afterState._fieldDiff`.
 * - Writes are FAIL-CLOSED: no silent catch. AuditService.log accepts an
 *   optional transaction client so audit rows are written INSIDE the
 *   business transaction (pass the tx through); when omitted, the write
 *   runs in its own transaction.
 *
 * MIGRATION (worker 4, landed): added `sequence Int @unique` (NOT NULL,
 * backfilled 1..N) + `schemeVersion Int @default(1)` to AuditLog; existing
 * rows are schemeVersion=1. Until the migration lands, log() transparently
 * falls back to the v1 Prisma path (no sequence) — pre-migration rows stay
 * v1 and the first post-migration write emits the v2 checkpoint.
 *
 * NOTE — tamper-evident ≠ tamper-proof: a party with direct DB write access
 * can rewrite the entire chain from genesis and recompute valid hashes. This
 * mechanism detects casual tampering and application-layer bugs; evidentiary
 * strength additionally requires append-only DB permissions, off-site hash
 * anchoring, and restricted DB access.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: RecordAuditParams, tx?: AuditTxClient) {
    const createdAt = new Date();

    // Mask PII BEFORE hashing/storage. The field-level diff is computed on
    // the UNMASKED states so changed PII fields still appear in the diff —
    // with their values redacted — then the stored states are masked.
    const beforeState = params.beforeState !== undefined ? maskPii(params.beforeState) : null;
    const afterStateRaw = params.afterState !== undefined ? maskPii(params.afterState) : null;
    let afterState = afterStateRaw;
    if (
      (isPlainObject(params.beforeState) || isPlainObject(params.afterState)) &&
      isPlainObject(afterStateRaw)
    ) {
      const rawDiff = buildFieldDiff(params.beforeState, params.afterState);
      const maskedDiff = maskDiffValues(rawDiff);
      if (Object.keys(maskedDiff).length > 0) {
        afterState = { ...afterStateRaw, _fieldDiff: maskedDiff };
      }
    }

    const canonicalPayload = canonicalAuditPayload({
      actorId: params.actorId,
      actorEmail: params.actorEmail,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeState,
      afterState,
      ipAddress: params.ipAddress,
      createdAt: createdAt.toISOString(),
    });

    const rowData = {
      actorId: params.actorId,
      actorEmail: params.actorEmail,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeState,
      afterState,
      ipAddress: params.ipAddress,
      canonicalPayload,
      createdAt,
    };

    const run = async (client: AuditTxClient) => {
      try {
        return await this.insertV2(client, rowData);
      } catch (error) {
        if (isMissingColumnError(error)) {
          // Pre-migration database: fall back to the v1 Prisma path.
          return this.insertV1(client, rowData);
        }
        throw error;
      }
    };

    // Fail-closed: no silent catch. When a tx client is supplied the audit
    // row joins the caller's transaction; otherwise it gets its own.
    if (tx) return run(tx);
    return this.prisma.$transaction((t) => run(t as unknown as AuditTxClient));
  }

  /**
   * v2 insert: advisory-lock the chain head, read the latest row
   * (SELECT … FOR UPDATE), emit the v1→v2 checkpoint when needed, then
   * insert with sequence + schemeVersion.
   */
  private async insertV2(client: AuditTxClient, row: any) {
    // Serialize chain-head writers for the duration of this transaction.
    await client.$queryRaw`SELECT pg_advisory_xact_lock(420001, 7)::text`;

    const latest = await client.$queryRaw<
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

      // First v2 write after v1 history: emit the checkpoint row so the
      // scheme transition is itself part of the chain. The checkpoint is
      // hashed in the canonical payload form (see canonicalAuditPayload —
      // finding #6), NOT in a special checkpoint schema, so verification
      // recomputes the identical hash from the stored columns. The
      // transition details are carried in afterState; entityType
      // 'AUDIT_CHAIN' marks the row as a checkpoint.
      if ((head.schemeVersion ?? 1) < CURRENT_SCHEME_VERSION) {
        const checkpointAfterState = {
          schemeVersion: CURRENT_SCHEME_VERSION,
          previousHeadHash: prevHash,
        };
        const checkpointPayload = canonicalAuditPayload({
          action: AuditAction.UPDATE,
          entityType: 'AUDIT_CHAIN',
          entityId: 'scheme-v2-checkpoint',
          beforeState: null,
          afterState: checkpointAfterState,
          ipAddress: null,
          createdAt: row.createdAt.toISOString(),
        });
        const checkpointHash = computeAuditHash(prevHash, checkpointPayload);
        const checkpointSequence = nextSequence;
        const checkpointId = randomUUID();
        await client.$queryRaw`
          INSERT INTO audit_logs
            ("entityType", "entityId", action, "beforeState", "afterState",
             "prevHash", hash, "createdAt", "sequence", "schemeVersion", id)
          VALUES (
            'AUDIT_CHAIN', ${`scheme-v2-checkpoint`}, 'UPDATE'::"AuditAction",
            NULL, ${JSON.stringify(checkpointAfterState)}::jsonb,
            ${prevHash}, ${checkpointHash}, ${row.createdAt.toISOString()}::timestamp,
            ${checkpointSequence}, ${CURRENT_SCHEME_VERSION}, ${checkpointId}
          )
          RETURNING id
        `;
        prevHash = checkpointHash;
        nextSequence = checkpointSequence + 1;
      }
    }

    const hash = computeAuditHash(prevHash, row.canonicalPayload);
    const rowId = randomUUID();
    const inserted = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO audit_logs
        ("actorId", "actorEmail", action, "entityType", "entityId",
         "beforeState", "afterState", "ipAddress",
         "prevHash", hash, "createdAt", "sequence", "schemeVersion", id)
      VALUES (
        ${row.actorId ?? null}, ${row.actorEmail ?? null}, ${row.action}::"AuditAction",
        ${row.entityType}, ${row.entityId},
        ${row.beforeState ? JSON.stringify(row.beforeState) : null}::jsonb,
        ${row.afterState ? JSON.stringify(row.afterState) : null}::jsonb,
        ${row.ipAddress ?? null},
        ${prevHash}, ${hash}, ${row.createdAt.toISOString()}::timestamp,
        ${nextSequence}, ${CURRENT_SCHEME_VERSION}, ${rowId}
      )
      RETURNING id
    `;

    return {
      id: inserted[0]?.id ?? rowId,
      ...row,
      prevHash,
      hash,
      sequence: nextSequence,
      schemeVersion: CURRENT_SCHEME_VERSION,
    };
  }

  /** v1 insert: the pre-migration Prisma path (no sequence/schemeVersion). */
  private async insertV1(client: AuditTxClient, row: any) {
    const latest = await client.auditLog.findFirst({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true },
    });
    const prevHash = latest?.hash ?? GENESIS_HASH;
    const hash = computeAuditHash(prevHash, row.canonicalPayload);
    return client.auditLog.create({
      data: {
        actorId: row.actorId,
        actorEmail: row.actorEmail,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        beforeState: row.beforeState ?? undefined,
        afterState: row.afterState ?? undefined,
        ipAddress: row.ipAddress,
        prevHash,
        hash,
        createdAt: row.createdAt,
      },
    });
  }

  async getLogs(
    entityType?: string,
    entityId?: string,
    page = 1,
    limit = 50,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {
      ...(entityType && { entityType }),
      ...(entityId && { entityId }),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Math.min(limit, 200),
        include: {
          actor: { select: { id: true, email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    // Same envelope as every other list endpoint: {items, meta:{total,page,…}}
    return createPaginatedResponse(items, total, page, limit);
  }

  /**
   * Replays the hash chain oldest → newest, recomputing every row's hash from
   * its stored prevHash + canonical payload. Post-migration the replay is
   * ordered by `sequence`; pre-migration it falls back to (createdAt, id).
   * Batches are cursor-paginated (sequence / (createdAt,id)), not OFFSET —
   * see verifyChainV2.
   *
   * With `allowTruncation`, a chain whose oldest surviving row links to a
   * purged predecessor (explained by a recorded truncation checkpoint) is
   * reported `{ valid: true, truncated: true }` instead of failing.
   */
  async verifyChain(
    batchSize = 500,
    opts: { allowTruncation?: boolean } = {},
  ): Promise<ChainVerificationResult> {
    try {
      return await this.verifyChainV2(batchSize, opts);
    } catch (error) {
      if (isMissingColumnError(error)) {
        return this.verifyChainV1(batchSize);
      }
      throw error;
    }
  }

  /**
   * Replay the chain with CURSOR pagination (go-live hardening, §5).
   *
   * The old implementation used OFFSET paging (`OFFSET n`), which re-scans
   * from the start on every batch and degrades as the log grows (and can
   * skip/duplicate rows if rows are appended concurrently). The cursor is
   * the unique, monotonically increasing `sequence`: each batch resumes
   * exactly where the previous one ended (`WHERE sequence > :cursor`),
   * which is O(batch) per page regardless of table size and stable under
   * concurrent appends.
   */
  private async verifyChainV2(
    batchSize: number,
    opts: { allowTruncation?: boolean },
  ): Promise<ChainVerificationResult> {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    let truncated = false;
    // Cursor: the last sequence verified. `sequence` is unique and assigned
    // in chain order, so this is a stable resume point.
    let lastSequence = 0;

    for (;;) {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          actorId: string | null;
          actorEmail: string | null;
          action: string;
          entityType: string;
          entityId: string;
          beforeState: any;
          afterState: any;
          ipAddress: string | null;
          prevHash: string | null;
          hash: string | null;
          createdAt: Date;
          sequence: number;
        }>
      >`
        SELECT id, "actorId", "actorEmail", action, "entityType", "entityId",
               "beforeState", "afterState", "ipAddress", "prevHash", hash, "createdAt",
               "sequence"
        FROM audit_logs
        WHERE "sequence" > ${lastSequence}
        ORDER BY "sequence" ASC
        LIMIT ${Math.min(batchSize, 1000)}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row.prevHash !== prevHash) {
          if (checked === 0 && opts.allowTruncation && (await this.isTruncationExplained(row.prevHash))) {
            // The rows before this one were purged under retention and the
            // truncation was checkpointed — re-anchor here.
            truncated = true;
            prevHash = row.prevHash!;
          } else {
            return {
              valid: false,
              checked,
              failedAt: {
                id: row.id,
                reason: `prevHash mismatch: expected chain head ${prevHash}, row links to ${row.prevHash}`,
              },
            };
          }
        }
        const canonicalPayload = canonicalAuditPayload({
          actorId: row.actorId,
          actorEmail: row.actorEmail,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          beforeState: row.beforeState,
          afterState: row.afterState,
          ipAddress: row.ipAddress,
          createdAt: new Date(row.createdAt).toISOString(),
        });
        const expected = computeAuditHash(row.prevHash!, canonicalPayload);
        if (row.hash !== expected) {
          return {
            valid: false,
            checked,
            failedAt: { id: row.id, reason: 'row hash does not match recomputed hash (payload tampered)' },
          };
        }
        prevHash = row.hash!;
        checked++;
        lastSequence = row.sequence;
      }
    }

    this.logger.log(`Audit chain verification complete: ${checked} rows valid${truncated ? ' (truncated history)' : ''}`);
    return { valid: true, checked, truncated: truncated || undefined };
  }

  /**
   * Pre-migration verification path (original behaviour), cursor-paginated on
   * (createdAt, id) since `sequence` does not exist yet.
   */
  private async verifyChainV1(batchSize: number): Promise<ChainVerificationResult> {
    let prevHash = GENESIS_HASH;
    let checked = 0;
    // Cursor: (createdAt, id) is unique-enough and monotonic for replay
    // order; strictly better than OFFSET for the same reasons as above.
    let lastCreatedAt = new Date(0);
    let lastId = '';

    for (;;) {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          actorId: string | null;
          actorEmail: string | null;
          action: string;
          entityType: string;
          entityId: string;
          beforeState: any;
          afterState: any;
          ipAddress: string | null;
          prevHash: string | null;
          hash: string | null;
          createdAt: Date;
        }>
      >`
        SELECT id, "actorId", "actorEmail", action, "entityType", "entityId",
               "beforeState", "afterState", "ipAddress", "prevHash", hash, "createdAt"
        FROM audit_logs
        WHERE "createdAt" > ${lastCreatedAt.toISOString()}::timestamp
           OR ("createdAt" = ${lastCreatedAt.toISOString()}::timestamp AND id > ${lastId})
        ORDER BY "createdAt" ASC, id ASC
        LIMIT ${Math.min(batchSize, 1000)}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row.prevHash !== prevHash) {
          return {
            valid: false,
            checked,
            failedAt: {
              id: row.id,
              reason: `prevHash mismatch: expected chain head ${prevHash}, row links to ${row.prevHash}`,
            },
          };
        }
        const canonicalPayload = canonicalAuditPayload({
          actorId: row.actorId,
          actorEmail: row.actorEmail,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          beforeState: row.beforeState,
          afterState: row.afterState,
          ipAddress: row.ipAddress,
          createdAt: row.createdAt.toISOString(),
        });
        const expected = computeAuditHash(row.prevHash!, canonicalPayload);
        if (row.hash !== expected) {
          return {
            valid: false,
            checked,
            failedAt: { id: row.id, reason: 'row hash does not match recomputed hash (payload tampered)' },
          };
        }
        prevHash = row.hash!;
        checked++;
        lastCreatedAt = new Date(row.createdAt);
        lastId = row.id;
      }
    }

    this.logger.log(`Audit chain verification complete: ${checked} rows valid`);
    return { valid: true, checked };
  }

  /**
   * True when a truncation checkpoint explains why the oldest surviving row
   * links to `deletedThroughHash` instead of GENESIS.
   */
  private async isTruncationExplained(prevHash: string | null): Promise<boolean> {
    if (!prevHash) return false;
    try {
      const hits = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM audit_logs
        WHERE "entityType" = 'AUDIT_CHAIN'
          AND "afterState"->>'deletedThroughHash' = ${prevHash}
        LIMIT 1
      `;
      return hits.length > 0;
    } catch (error) {
      if (isMissingColumnError(error)) return false;
      throw error;
    }
  }

  /**
   * Retention purge (configurable via AUDIT_RETENTION_DAYS).
   *
   * ASSUMPTION (counsel sign-off pending): 7 years (2555 days) is the UK
   * statutory ceiling for payroll-adjacent records (HMRC requires 3–6 years
   * depending on record class; 7 is the conservative superset). Non-statutory
   * rows could be purged sooner — that policy needs counsel sign-off before
   * this runs on a schedule.
   *
   * DRY-RUN BY DEFAULT — the same ONE gate as the GDPR multi-entity purge
   * and the worker AI-log purge (@ems/shared `retention.ts`): a real delete
   * happens only when BOTH hold:
   *   1. counsel sign-off is recorded (`GDPR_RETENTION_SIGNED_OFF=true`), AND
   *   2. the caller explicitly passes `{ dryRun: false }`.
   * An explicit `dryRun: false` without sign-off is forced back to dry-run
   * and logged loudly — audit rows must never be deleted on placeholder
   * retention windows. In dry-run mode nothing is deleted AND no truncation
   * checkpoint is written (the chain is untouched, so no re-anchoring is
   * needed); the run only counts + logs what it would delete.
   *
   * The chain head is never deleted. After deleting expired rows a truncation
   * checkpoint is written so verifyChain({ allowTruncation: true }) stays
   * green; without the flag, verification correctly reports the break.
   * Wire to a worker cron (reported as follow-up for worker 1).
   */
  async purgeExpiredAuditLogs(opts?: {
    dryRun?: boolean;
  }): Promise<{ deleted: number; matched: number; dryRun: boolean; signedOff: boolean; checkpointId: string | null }> {
    const signedOff = isRetentionSignedOff();
    const dryRun = !(signedOff && opts?.dryRun === false);
    if (opts?.dryRun === false && !signedOff) {
      this.logger.warn(
        'Audit purge requested with dryRun:false but counsel sign-off is not recorded ' +
          `(${RETENTION_SIGNOFF_ENV}!=true) — forcing DRY-RUN.`,
      );
    }
    const mode = dryRun ? 'DRY-RUN — no rows deleted' : 'LIVE DELETE';

    const days = parseInt(process.env.AUDIT_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
    const cutoff = new Date(Date.now() - days * 86400_000);
    this.logger.log(
      `Audit retention purge [${mode}]: retention window ${days}d, cutoff ${cutoff.toISOString()}, ` +
        `signedOff=${signedOff}, dryRun=${dryRun}`,
    );

    return this.prisma.$transaction(async (tx) => {
      const client = tx as unknown as AuditTxClient;
      const newest = await client.auditLog.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!newest) {
        this.logger.log(`Audit retention purge [${mode}]: no audit rows — nothing to do`);
        return { deleted: 0, matched: 0, dryRun, signedOff, checkpointId: null };
      }

      const doomed = await client.$queryRaw<Array<{ id: string; hash: string | null }>>`
        SELECT id, hash FROM audit_logs
        WHERE "createdAt" < ${cutoff.toISOString()}::timestamp AND id <> ${newest.id}
        ORDER BY "createdAt" ASC
      `;
      if (doomed.length === 0) {
        this.logger.log(
          `Audit retention purge [${mode}]: no rows older than ${cutoff.toISOString()} — nothing to do`,
        );
        return { deleted: 0, matched: 0, dryRun, signedOff, checkpointId: null };
      }

      if (dryRun) {
        // DRY-RUN: count + log only. No DELETE and no truncation
        // checkpoint — the chain is untouched.
        this.logger.log(
          `Audit retention purge [DRY-RUN]: would delete ${doomed.length} audit rows ` +
            `older than ${cutoff.toISOString()} — no rows deleted`,
        );
        return { deleted: 0, matched: doomed.length, dryRun, signedOff, checkpointId: null };
      }

      // LIVE DELETE path.
      const deletedThroughHash = doomed[doomed.length - 1].hash ?? GENESIS_HASH;
      await client.$queryRaw`
        DELETE FROM audit_logs WHERE id = ANY(${doomed.map((d) => d.id)})
      `;

      const createdAt = new Date();
      // The truncation checkpoint is hashed in the canonical payload form
      // (see canonicalAuditPayload — finding #6) so verifyChain recomputes
      // the identical hash from the stored columns.
      const checkpointAfterState = {
        deletedRows: doomed.length,
        deletedThroughHash,
      };
      const checkpointPayload = canonicalAuditPayload({
        action: AuditAction.UPDATE,
        entityType: 'AUDIT_CHAIN',
        entityId: 'retention-truncation',
        beforeState: null,
        afterState: checkpointAfterState,
        ipAddress: null,
        createdAt: createdAt.toISOString(),
      });

      let checkpointId: string | null = null;
      try {
        await client.$queryRaw`SELECT pg_advisory_xact_lock(420001, 7)::text`;
        const latest = await client.$queryRaw<
          Array<{ hash: string | null; sequence: number | null }>
        >`
          SELECT hash, "sequence" FROM audit_logs
          ORDER BY "sequence" DESC NULLS LAST, "createdAt" DESC, id DESC
          LIMIT 1 FOR UPDATE
        `;
        const prevHash = latest[0]?.hash ?? GENESIS_HASH;
        const sequence = (latest[0]?.sequence ?? 0) + 1;
        const hash = computeAuditHash(prevHash, checkpointPayload);
        const truncationId = randomUUID();
        const inserted = await client.$queryRaw<Array<{ id: string }>>`
          INSERT INTO audit_logs
            ("entityType", "entityId", action, "afterState",
             "prevHash", hash, "createdAt", "sequence", "schemeVersion", id)
          VALUES (
            'AUDIT_CHAIN', 'retention-truncation', 'UPDATE'::"AuditAction",
            ${JSON.stringify(checkpointAfterState)}::jsonb,
            ${prevHash}, ${hash}, ${createdAt.toISOString()}::timestamp,
            ${sequence}, ${CURRENT_SCHEME_VERSION}, ${truncationId}
          )
          RETURNING id
        `;
        checkpointId = inserted[0]?.id ?? null;
      } catch (error) {
        if (!isMissingColumnError(error)) throw error;
        // Pre-migration: checkpoint without sequence/schemeVersion, linked
        // to the real chain head (not GENESIS).
        const head = await client.auditLog.findFirst({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { hash: true },
        });
        const prevHash = head?.hash ?? GENESIS_HASH;
        const created = await client.auditLog.create({
          data: {
            entityType: 'AUDIT_CHAIN',
            entityId: 'retention-truncation',
            action: AuditAction.UPDATE,
            afterState: checkpointAfterState,
            prevHash,
            hash: computeAuditHash(prevHash, checkpointPayload),
            createdAt,
          },
        });
        checkpointId = created.id;
      }

      this.logger.log(`Purged ${doomed.length} audit rows older than ${cutoff.toISOString()}`);
      return { deleted: doomed.length, matched: doomed.length, dryRun, signedOff, checkpointId };
    });
  }
}
