import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditService,
  canonicalize,
  canonicalAuditPayload,
  computeAuditHash,
  maskPii,
  buildFieldDiff,
} from './audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction } from '@ems/shared';

/** Minimal Decimal stand-in with the same toJSON() contract as Prisma.Decimal. */
class FakeDecimal {
  constructor(private readonly value: string) {}
  toJSON() {
    return this.value;
  }
}

describe('audit canonicalization & masking', () => {
  it('canonicalizes with sorted keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('serializes Decimal as its canonical decimal string (money fix)', () => {
    const payload = { grossPay: new FakeDecimal('1250.50'), note: 'x' };
    const canon = canonicalize(payload);
    expect(canon).toContain('"grossPay":"1250.50"');
    // Same logical value built differently hashes identically.
    expect(canonicalize({ note: 'x', grossPay: new FakeDecimal('1250.50') })).toBe(canon);
  });

  it('masks PII/salary fields deeply', () => {
    const masked: any = maskPii({
      firstName: 'Ada',
      salary: 90000,
      bankAccountEnc: 'enc-blob',
      nested: { taxId: 'AB123', ok: 1 },
      list: [{ niNumber: 'QQ12' }],
    });
    expect(masked.firstName).toBe('Ada');
    expect(masked.salary).toBe('[REDACTED]');
    expect(masked.bankAccountEnc).toBe('[REDACTED]');
    expect(masked.nested.taxId).toBe('[REDACTED]');
    expect(masked.nested.ok).toBe(1);
    expect(masked.list[0].niNumber).toBe('[REDACTED]');
  });

  it('builds field-level diffs', () => {
    const diff: any = buildFieldDiff(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 5, d: 9 },
    );
    expect(Object.keys(diff).sort()).toEqual(['b', 'c', 'd']);
    expect(diff.b).toEqual({ before: 2, after: 5 });
    expect(diff.c).toEqual({ before: 3, after: null });
    expect(diff.d).toEqual({ before: null, after: 9 });
  });
});

describe('AuditService.log', () => {
  let service: AuditService;
  let tx: any;

  const wire = (queryRawImpl: jest.Mock) => {
    tx = {
      $queryRaw: queryRawImpl,
      auditLog: { findFirst: jest.fn(), create: jest.fn() },
    };
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: { $transaction: jest.fn() } },
      ],
    }).compile();
    service = module.get<AuditService>(AuditService);
  });

  it('writes inside the caller transaction and stores a masked field diff', async () => {
    const calls: string[] = [];
    wire(
      jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        calls.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('LIMIT 1') && sql.includes('FOR UPDATE')) return []; // empty chain
        if (sql.includes('RETURNING id')) return [{ id: 'row-1' }];
        return [];
      }),
    );

    const result: any = await service.log(
      {
        actorId: 'user-1',
        action: AuditAction.UPDATE,
        entityType: 'EMPLOYEE',
        entityId: 'emp-1',
        beforeState: { firstName: 'Ada', salary: 90000 },
        afterState: { firstName: 'Ada Lovelace', salary: 95000 },
      },
      tx,
    );

    expect(result.schemeVersion).toBe(2);
    expect(result.sequence).toBe(1);
    expect(result.hash).toBe(computeAuditHash('GENESIS', result.canonicalPayload));
    // PII masked before hashing/storage; diff recorded under _fieldDiff.
    expect(result.afterState.salary).toBe('[REDACTED]');
    expect(result.afterState._fieldDiff.firstName).toEqual({
      before: 'Ada',
      after: 'Ada Lovelace',
    });
    expect(result.afterState._fieldDiff.salary.after).toBe('[REDACTED]');
    expect(calls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('emits a v1→v2 checkpoint row on the first v2 write after v1 history', async () => {
    const inserted: string[] = [];
    wire(
      jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FOR UPDATE')) {
          return [{ id: 'v1-row', hash: 'abc123', sequence: 41, schemeVersion: 1 }];
        }
        if (sql.includes('RETURNING id')) {
          inserted.push(sql);
          return [{ id: 'new-row' }];
        }
        return [];
      }),
    );

    const result: any = await service.log(
      { action: AuditAction.CREATE, entityType: 'X', entityId: 'y' },
      tx,
    );
    // One raw INSERT for the checkpoint + one for the row.
    expect(inserted.length).toBe(2);
    expect(inserted[0]).toContain('AUDIT_CHAIN');
    expect(result.sequence).toBe(43); // 41 → checkpoint 42 → row 43
    expect(result.prevHash).not.toBe('abc123'); // chains off the checkpoint
  });

  it('falls back to the v1 Prisma path when v2 columns are not migrated', async () => {
    const missingColumn = Object.assign(new Error('column "sequence" does not exist'), {});
    wire(jest.fn(async () => {
      throw missingColumn;
    }));
    tx.auditLog.findFirst.mockResolvedValue({ hash: 'prev' });
    tx.auditLog.create.mockImplementation(async (args: any) => ({ id: 'v1-row', ...args.data }));

    const result: any = await service.log(
      { action: AuditAction.CREATE, entityType: 'X', entityId: 'y' },
      tx,
    );
    expect(result.id).toBe('v1-row');
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(result.sequence).toBeUndefined();
  });
});

describe('AuditService.verifyChain with checkpoints (finding #6)', () => {
  let service: AuditService;
  let prisma: any;

  const t = (iso: string) => new Date(iso);

  /**
   * Builds a 3-row chain exactly as the writers produce it:
   * legacy v1 row → v2 scheme checkpoint → regular v2 row.
   * The checkpoint row is hashed in the CANONICAL payload form
   * (canonicalAuditPayload), not a special checkpoint schema.
   */
  function buildChainWithCheckpoint() {
    const payload1 = canonicalAuditPayload({
      action: AuditAction.CREATE,
      entityType: 'EMPLOYEE',
      entityId: 'emp-1',
      beforeState: null,
      afterState: { firstName: 'Ada' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const hash1 = computeAuditHash('GENESIS', payload1);
    const row1 = {
      id: 'v1-row',
      actorId: null,
      actorEmail: null,
      action: 'CREATE',
      entityType: 'EMPLOYEE',
      entityId: 'emp-1',
      beforeState: null,
      afterState: { firstName: 'Ada' },
      ipAddress: null,
      prevHash: 'GENESIS',
      hash: hash1,
      createdAt: t('2026-01-01T00:00:00.000Z'),
      sequence: 41,
    };

    const checkpointAfterState = { schemeVersion: 2, previousHeadHash: hash1 };
    const payload2 = canonicalAuditPayload({
      action: AuditAction.UPDATE,
      entityType: 'AUDIT_CHAIN',
      entityId: 'scheme-v2-checkpoint',
      beforeState: null,
      afterState: checkpointAfterState,
      ipAddress: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const hash2 = computeAuditHash(hash1, payload2);
    const row2 = {
      id: 'checkpoint',
      actorId: null,
      actorEmail: null,
      action: 'UPDATE',
      entityType: 'AUDIT_CHAIN',
      entityId: 'scheme-v2-checkpoint',
      beforeState: null,
      afterState: checkpointAfterState,
      ipAddress: null,
      prevHash: hash1,
      hash: hash2,
      createdAt: t('2026-01-02T00:00:00.000Z'),
      sequence: 42,
    };

    const payload3 = canonicalAuditPayload({
      action: AuditAction.UPDATE,
      entityType: 'EMPLOYEE',
      entityId: 'emp-1',
      beforeState: { firstName: 'Ada' },
      afterState: { firstName: 'Ada Lovelace' },
      ipAddress: null,
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    const hash3 = computeAuditHash(hash2, payload3);
    const row3 = {
      id: 'v2-row',
      actorId: null,
      actorEmail: null,
      action: 'UPDATE',
      entityType: 'EMPLOYEE',
      entityId: 'emp-1',
      beforeState: { firstName: 'Ada' },
      afterState: { firstName: 'Ada Lovelace' },
      ipAddress: null,
      prevHash: hash2,
      hash: hash3,
      createdAt: t('2026-01-03T00:00:00.000Z'),
      sequence: 43,
    };
    return [row1, row2, row3];
  }

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn(), $transaction: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<AuditService>(AuditService);
  });

  /** verifyChainV2 paginates by cursor; first call returns rows, second ends it. */
  const wireVerify = (rows: any[]) => {
    let calls = 0;
    prisma.$queryRaw.mockImplementation(async () => (calls++ === 0 ? rows : []));
  };

  it('verifies a chain containing a scheme checkpoint end-to-end', async () => {
    wireVerify(buildChainWithCheckpoint());
    const result = await service.verifyChain(500);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.failedAt).toBeUndefined();
  });

  it('detects a tampered row after a checkpoint', async () => {
    const rows = buildChainWithCheckpoint();
    // Tamper with the stored payload of the newest row.
    rows[2] = { ...rows[2], afterState: { firstName: 'Eve Mallory' } };
    wireVerify(rows);
    const result = await service.verifyChain(500);
    expect(result.valid).toBe(false);
    expect(result.failedAt?.id).toBe('v2-row');
    expect(result.failedAt?.reason).toContain('tampered');
  });
});

describe('AuditService.purgeExpiredAuditLogs (finding #7)', () => {
  let service: AuditService;
  let prisma: any;
  let tx: any;

  const SIGNOFF_ENV = 'GDPR_RETENTION_SIGNED_OFF';
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[SIGNOFF_ENV];
    tx = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('SELECT id, hash FROM audit_logs')) {
          return [
            { id: 'old-1', hash: 'h1' },
            { id: 'old-2', hash: 'h2' },
          ];
        }
        if (sql.includes('DELETE FROM audit_logs')) return [];
        if (sql.includes('SELECT hash, "sequence"')) {
          return [{ hash: 'head-hash', sequence: 10 }];
        }
        if (sql.includes('INSERT INTO audit_logs')) return [{ id: 'ckpt-1' }];
        return [];
      }),
      auditLog: { findFirst: jest.fn(async () => ({ id: 'newest-1' })) },
    };
    prisma = {
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      $queryRaw: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<AuditService>(AuditService);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SIGNOFF_ENV];
    else process.env[SIGNOFF_ENV] = savedEnv;
  });

  const deleteWasCalled = () =>
    tx.$queryRaw.mock.calls.some((c: any[]) =>
      c[0].join(' ').includes('DELETE FROM audit_logs'),
    );

  it('forces DRY-RUN (deleting nothing) when sign-off is missing, even with dryRun:false', async () => {
    delete process.env[SIGNOFF_ENV];
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    const result = await service.purgeExpiredAuditLogs({ dryRun: false });

    expect(result.dryRun).toBe(true);
    expect(result.signedOff).toBe(false);
    expect(result.deleted).toBe(0);
    expect(result.matched).toBe(2);
    expect(result.checkpointId).toBeNull();
    // Loud log: the forced dry-run is announced.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('forcing DRY-RUN'));
    expect(deleteWasCalled()).toBe(false);
    warnSpy.mockRestore();
  });

  it('deletes only with sign-off AND explicit dryRun:false', async () => {
    process.env[SIGNOFF_ENV] = 'true';
    const result = await service.purgeExpiredAuditLogs({ dryRun: false });

    expect(result).toEqual({
      deleted: 2,
      matched: 2,
      dryRun: false,
      signedOff: true,
      checkpointId: 'ckpt-1',
    });
    expect(deleteWasCalled()).toBe(true);

    // The written truncation checkpoint verifies green: recompute its hash
    // from the stored columns the same way verifyChain does.
    const insertCall = tx.$queryRaw.mock.calls.find((c: any[]) =>
      c[0].join(' ').includes('INSERT INTO audit_logs'),
    );
    expect(insertCall).toBeDefined();
    const [afterStateJson, prevHash, hash, createdAtIso] = insertCall.slice(1);
    const recomputed = computeAuditHash(
      prevHash,
      canonicalAuditPayload({
        action: AuditAction.UPDATE,
        entityType: 'AUDIT_CHAIN',
        entityId: 'retention-truncation',
        beforeState: null,
        afterState: JSON.parse(afterStateJson),
        ipAddress: null,
        createdAt: createdAtIso,
      }),
    );
    expect(hash).toBe(recomputed);
  });

  it('dry-runs by default even when counsel has signed off', async () => {
    process.env[SIGNOFF_ENV] = 'true';
    const result = await service.purgeExpiredAuditLogs();

    expect(result.dryRun).toBe(true);
    expect(result.signedOff).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.matched).toBe(2);
    expect(deleteWasCalled()).toBe(false);
  });
});
