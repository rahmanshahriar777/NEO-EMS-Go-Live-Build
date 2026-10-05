/**
 * Payroll concurrency invariants — unit level (mocked Prisma).
 *
 * True row-level races need a real database (see
 * test/payroll-concurrency.e2e-spec.ts). What CAN be tested honestly without
 * a DB:
 *  1. sequential double-approve: approve -> approve again -> the second is
 *     rejected (only DRAFT runs are approvable);
 *  2. duplicate-create race: two overlapping createPayrollRun calls for the
 *     same period, both passing the findFirst guard, resolve to exactly one
 *     success + one 409 via the P2002 backstop;
 *  3. sequential double-disburse: re-disbursing a PAID run is a no-op with
 *     no side effects (no audit write, no notifications, no fresh timestamp).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PayrollService } from './payroll.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { QueueService } from '../../core/queues/queue.service';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { PayrollStatus, AuditAction } from '@ems/shared';

describe('payroll concurrency', () => {
  let service: PayrollService;
  let prisma: any;
  let audit: any;
  let queues: any;

  const oneEmployee = () => ({
    id: 'emp-1',
    salaryStructures: [
      { baseSalary: 5000, salaryStructure: { components: [] } },
    ],
  });

  beforeEach(async () => {
    prisma = {
      payrollRun: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      payslip: { updateMany: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      employee: { findMany: jest.fn() },
      employeeSalaryStructure: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
      salaryStructure: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
      auditLog: { findFirst: jest.fn() },
      $transaction: jest.fn((cb: any) =>
        cb({ payrollRun: prisma.payrollRun, payslip: prisma.payslip, employeeSalaryStructure: prisma.employeeSalaryStructure }),
      ),
    };
    audit = { log: jest.fn() };
    queues = { enqueuePayrollRun: jest.fn().mockResolvedValue('job-1'), enqueueNotification: jest.fn().mockResolvedValue('job-2') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: QueueService, useValue: queues },
      ],
    }).compile();

    service = module.get<PayrollService>(PayrollService);
  });

  it('sequential double-approve: the second approval is rejected (only DRAFT)', async () => {
    prisma.payrollRun.findUnique
      .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.DRAFT, processedAt: new Date() })
      .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.APPROVED });
    prisma.auditLog.findFirst.mockResolvedValue({ actorId: 'maker-1' });
    prisma.payslip.count.mockResolvedValue(1);
    prisma.payrollRun.update.mockImplementation(({ data }: any) => ({ id: 'run-1', ...data }));

    const first = await service.approvePayrollRun('run-1', 'checker-1');
    expect(first.status).toBe(PayrollStatus.APPROVED);

    await expect(service.approvePayrollRun('run-1', 'checker-2')).rejects.toThrow(BadRequestException);
    // Only one approval audit entry — the rejected attempt writes nothing.
    expect(audit.log.mock.calls.filter((c: any[]) => c[0].action === AuditAction.APPROVE)).toHaveLength(1);
  });

  it('duplicate-create race: two overlapping creates -> one 201, one 409 (P2002 backstop)', async () => {
    prisma.payrollRun.findFirst.mockResolvedValue(null); // both pass the guard
    prisma.employee.findMany.mockResolvedValue([oneEmployee()]);

    let resolveFirstCreate!: (v: any) => void;
    const firstCreateGate = new Promise((resolve) => {
      resolveFirstCreate = resolve;
    });
    let createCalls = 0;
    prisma.payrollRun.create.mockImplementation(() => {
      createCalls += 1;
      if (createCalls === 1) return firstCreateGate; // hold the first tx open
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });

    const p1 = service.createPayrollRun({ month: 9, year: 2026 }, 'maker-1');
    const p2 = service.createPayrollRun({ month: 9, year: 2026 }, 'maker-2');
    // Attach the settlement handler synchronously: the loser's rejection may
    // land before the test yields, and an un-observed rejection fails the
    // test in Jest even though allSettled would have captured it.
    const settled = Promise.allSettled([p1, p2]);
    // Let the second call reach its (failing) create before releasing the first.
    await new Promise((r) => setImmediate(r));
    resolveFirstCreate({ id: 'run-winner', month: 9, year: 2026, payslips: [] });

    const [r1, r2] = await settled;
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    // Exactly one background job enqueued — the loser enqueues nothing.
    expect(queues.enqueuePayrollRun).toHaveBeenCalledTimes(1);
  });

  it('sequential double-disburse: re-disbursing PAID is a side-effect-free no-op', async () => {
    const paidRun = {
      id: 'run-1',
      month: 9,
      year: 2026,
      status: PayrollStatus.PAID,
      payslips: [{ id: 'slip-1', employeeId: 'emp-1', netPay: 5000, employee: { userId: 'user-1' } }],
    };
    prisma.payrollRun.findUnique.mockResolvedValue(paidRun);

    const before = { ...paidRun };
    const result = await service.disbursePayrollRun('run-1', 'checker-1');

    expect(result.status).toBe(PayrollStatus.PAID);
    expect(prisma.payrollRun.update).not.toHaveBeenCalled();
    expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(queues.enqueueNotification).not.toHaveBeenCalled();
    // The stored run is returned unchanged (payslips stripped from the
    // response shape, as the service does); the stored disbursementDate is
    // the run's own, never a fresh timestamp.
    const { payslips: strippedSlips, ...beforeWithoutSlips } = before;
    expect(strippedSlips).toBeDefined(); // response shape strips payslips
    expect(result).toEqual(beforeWithoutSlips);
  });

  it('concurrent double-disburse: exactly one wins, the loser is a safe no-op (never double-applied)', async () => {
    // Stateful in-memory stand-in for the payroll_run row. BOTH concurrent
    // calls read APPROVED before either writes (the real race), but the
    // conditional update is atomic: exactly one writer observes
    // status === where.status; the loser sees no matching row -> P2025.
    let status = PayrollStatus.APPROVED;
    const storedDisbursementDate = new Date('2026-10-01T10:00:00.000Z');
    const runRow = () => ({
      id: 'run-1',
      month: 9,
      year: 2026,
      status,
      disbursementDate: status === PayrollStatus.PAID ? storedDisbursementDate : null,
      payslips: [{ id: 'slip-1', employeeId: 'emp-1', netPay: 5000, employee: { userId: 'user-1' } }],
    });
    prisma.payrollRun.findUnique.mockImplementation(() => Promise.resolve(runRow()));
    prisma.payrollRun.update.mockImplementation(({ where }: any) => {
      if (where.status !== status) {
        throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      }
      status = PayrollStatus.PAID;
      return Promise.resolve({ id: 'run-1', status });
    });
    prisma.payslip.updateMany.mockResolvedValue({ count: 1 });

    const [r1, r2] = await Promise.all([
      service.disbursePayrollRun('run-1', 'checker-1'),
      service.disbursePayrollRun('run-1', 'checker-2'),
    ]);

    // Both callers observe PAID and neither call threw (the loser is a no-op,
    // NOT a 409) — the idempotent re-disburse contract holds under a race.
    expect(r1.status).toBe(PayrollStatus.PAID);
    expect(r2.status).toBe(PayrollStatus.PAID);
    // Exactly-once side effects: one payslip stamp, one audit log entry, one
    // notification per payslip — never double-applied.
    expect(prisma.payslip.updateMany).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(queues.enqueueNotification).toHaveBeenCalledTimes(1);
    // The winner stamps a fresh disbursementDate; the loser re-reads the
    // stored state and reports the WINNER's disbursementDate — never a fresh
    // timestamp of its own, never undefined.
    expect(new Date(r1.disbursementDate).getTime()).not.toBe(storedDisbursementDate.getTime());
    expect(new Date(r2.disbursementDate).getTime()).toBe(storedDisbursementDate.getTime());
  });

  it('concurrent disburse-while-cancelled: the loser of the race gets 409, not a silent no-op', async () => {
    // The run leaves APPROVED between the guard read and the conditional
    // update (cancelled by a third party): the P2025 re-read sees CANCELLED
    // and the call is rejected with 409.
    prisma.payrollRun.findUnique
      .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.APPROVED, payslips: [] })
      .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.CANCELLED, payslips: [] });
    prisma.payrollRun.update.mockImplementation(() => {
      throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    });

    await expect(service.disbursePayrollRun('run-1', 'checker-1')).rejects.toThrow(ConflictException);
    expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('disburse-while-approving: a DRAFT run cannot be disbursed (409), even concurrently issued', async () => {
    prisma.payrollRun.findUnique.mockResolvedValue({ id: 'run-1', status: PayrollStatus.DRAFT, payslips: [] });

    await expect(service.disbursePayrollRun('run-1', 'checker-1')).rejects.toThrow(ConflictException);
    expect(prisma.payslip.updateMany).not.toHaveBeenCalled();
  });

  it('approvePayrollRun uses maker/checker from the audit trail, not the request', async () => {
    // Regression: approval must resolve the creator from the RUN_PAYROLL
    // audit row; here the audit row names a DIFFERENT user than the caller,
    // so approval proceeds and stamps approvedById with the caller.
    prisma.payrollRun.findUnique.mockResolvedValue({ id: 'run-1', status: PayrollStatus.DRAFT, processedAt: new Date() });
    prisma.auditLog.findFirst.mockResolvedValue({ actorId: 'maker-1', action: AuditAction.RUN_PAYROLL });
    prisma.payslip.count.mockResolvedValue(1);
    prisma.payrollRun.update.mockImplementation(({ data }: any) => ({ id: 'run-1', ...data }));

    const run = await service.approvePayrollRun('run-1', 'checker-9');

    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: { entityType: 'PAYROLL_RUN', entityId: 'run-1', action: AuditAction.RUN_PAYROLL },
      orderBy: { createdAt: 'asc' },
    });
    expect(run.approvedById).toBe('checker-9');
  });
});
