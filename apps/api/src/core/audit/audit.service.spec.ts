import { Test, TestingModule } from '@nestjs/testing';
import {
  AuditService,
  canonicalize,
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
