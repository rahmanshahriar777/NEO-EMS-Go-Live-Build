import { Test, TestingModule } from '@nestjs/testing';
import { PayrollService } from './payroll.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { QueueService } from '../../core/queues/queue.service';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PayrollStatus, AuditAction, SalaryComponentType, CalculationType } from '@ems/shared';

describe('PayrollService', () => {
  let service: PayrollService;
  let prismaService: any;
  let tx: any;
  let auditService: any;
  let queues: any;

  const approvedRun = (overrides: Record<string, any> = {}) => ({
    id: 'run-1',
    month: 9,
    year: 2026,
    status: PayrollStatus.APPROVED,
    payslips: [
      { id: 'slip-1', employeeId: 'emp-1', netPay: 6000, employee: { userId: 'user-1' } },
      { id: 'slip-2', employeeId: 'emp-2', netPay: 4500, employee: { userId: 'user-2' } },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    prismaService = {
      payrollRun: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      payslip: {
        updateMany: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
      employee: {
        findMany: jest.fn(),
      },
      employeeSalaryStructure: {
        updateMany: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      salaryStructure: {
        findMany: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
      },
      auditLog: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    // The transaction callback receives a client exposing the same models.
    tx = {
      payrollRun: prismaService.payrollRun,
      payslip: prismaService.payslip,
      employeeSalaryStructure: prismaService.employeeSalaryStructure,
    };
    prismaService.$transaction.mockImplementation((cb: any) => cb(tx));

    auditService = {
      log: jest.fn(),
    };

    queues = {
      enqueuePayrollRun: jest.fn().mockResolvedValue('job-1'),
      enqueueNotification: jest.fn().mockResolvedValue('job-2'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AuditService, useValue: auditService },
        // PAYROLL_CURRENCY unset -> GBP default
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: QueueService, useValue: queues },
      ],
    }).compile();

    service = module.get<PayrollService>(PayrollService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('duplicate-run guard (idempotency)', () => {
    it('should prevent duplicate payroll runs for the same period (idempotency)', async () => {
      prismaService.payrollRun.findFirst.mockResolvedValue({
        id: 'existing-run',
        month: 9,
        year: 2026,
        status: PayrollStatus.DRAFT,
      });

      await expect(service.createPayrollRun({ month: 9, year: 2026 })).rejects.toThrow(
        ConflictException,
      );
      expect(queues.enqueuePayrollRun).not.toHaveBeenCalled();
    });

    it('maps a P2002 unique-violation backstop to 409', async () => {
      prismaService.payrollRun.findFirst.mockResolvedValue(null);
      const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      prismaService.payrollRun.create.mockRejectedValue(p2002);

      await expect(service.createPayrollRun({ month: 9, year: 2026 })).rejects.toThrow(
        ConflictException,
      );
    });

    it('creates a DRAFT run shell with zero totals and enqueues computation (single-compute rule)', async () => {
      prismaService.payrollRun.findFirst.mockResolvedValue(null);
      prismaService.payrollRun.create.mockImplementation(({ data }: any) => ({
        id: 'run-new',
        ...data,
        payslips: [],
      }));

      const run = await service.createPayrollRun(
        { month: 9, year: 2026 },
        'maker-1',
        'maker@ems.local',
      );

      // The API must NOT compute: totals start at zero, no payslips, and the
      // worker is handed the job. All math (employment types, percentages,
      // proration) lives in the worker's single canonical implementation.
      expect(run.status).toBe(PayrollStatus.DRAFT);
      expect(Number(run.totalGross)).toBe(0);
      expect(Number(run.totalNet)).toBe(0);
      expect(run.payslips).toEqual([]);
      expect(prismaService.employee.findMany).not.toHaveBeenCalled();
      expect(queues.enqueuePayrollRun).toHaveBeenCalledWith('run-new', expect.any(String));
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.RUN_PAYROLL, entityType: 'PAYROLL_RUN' }),
      );
    });
  });

  describe('cancel / recalculate DRAFT runs', () => {
    it('cancel throws NotFoundException for an unknown run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(null);
      await expect(service.cancelPayrollRun('nope', 'hr-1')).rejects.toThrow(NotFoundException);
    });

    it('cancel rejects non-DRAFT runs', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.APPROVED,
      });
      await expect(service.cancelPayrollRun('run-1', 'hr-1')).rejects.toThrow(BadRequestException);
      expect(prismaService.payrollRun.update).not.toHaveBeenCalled();
    });

    it('cancel moves a DRAFT run to CANCELLED and audits', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.DRAFT,
      });
      prismaService.payrollRun.update.mockImplementation(({ data }: any) => ({
        id: 'run-1',
        ...data,
      }));

      const run = await service.cancelPayrollRun('run-1', 'hr-1', 'hr@ems.local');

      expect(run.status).toBe(PayrollStatus.CANCELLED);
      expect(prismaService.payrollRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: { status: PayrollStatus.CANCELLED },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'PAYROLL_RUN_CANCEL', entityId: 'run-1' }),
      );
    });

    it('recalculate throws NotFoundException for an unknown run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(null);
      await expect(service.recalculatePayrollRun('nope', 'hr-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('recalculate rejects PROCESSING runs (the worker owns the rows then)', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.PROCESSING,
      });
      await expect(service.recalculatePayrollRun('run-1', 'hr-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(queues.enqueuePayrollRun).not.toHaveBeenCalled();
    });

    it('recalculate drops draft payslips, resets totals and re-enqueues', async () => {
      prismaService.payrollRun.findUnique
        .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.DRAFT })
        .mockResolvedValueOnce({ id: 'run-1', status: PayrollStatus.DRAFT, payslips: [] });
      prismaService.payslip.deleteMany = jest.fn().mockResolvedValue({ count: 3 });

      await service.recalculatePayrollRun('run-1', 'hr-1', 'hr@ems.local');

      expect(prismaService.payslip.deleteMany).toHaveBeenCalledWith({
        where: { payrollRunId: 'run-1' },
      });
      expect(prismaService.payrollRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: { totalGross: 0, totalDeductions: 0, totalNet: 0, processedAt: null },
      });
      expect(queues.enqueuePayrollRun).toHaveBeenCalledWith('run-1', expect.any(String));
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'PAYROLL_RUN_RECALCULATE' }),
      );
    });
  });

  describe('payslip PDF + bank payment CSV', () => {
    const slip = {
      id: 'slip-1',
      employeeId: 'emp-1',
      grossPay: 6000,
      totalDeductions: 500,
      netPay: 5500,
      status: PayrollStatus.PAID,
      disbursementDate: new Date('2026-10-01'),
      breakdown: [
        { component: 'Base Salary', type: 'EARNING', amount: 5000 },
        { component: 'Housing', type: 'EARNING', amount: 1000 },
        { component: 'Tax', type: 'DEDUCTION', amount: 500 },
      ],
      employee: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        employeeNumber: 'EMP-001',
        department: { name: 'Engineering' },
        designation: { title: 'Engineer' },
      },
      payrollRun: { id: 'run-1', month: 9, year: 2026, status: PayrollStatus.PAID },
    };

    it('renders a PDF from stored payslip data (no recomputation)', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(slip);

      const { buffer, filename } = await service.getPayslipPdf('slip-1');

      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
      expect(filename).toContain('EMP-001');
      const text = buffer.toString('utf8');
      expect(text).toContain('Ada Lovelace');
      expect(text).toContain('5,500.00');
    });

    it('exports a bank payment CSV for a run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        month: 9,
        year: 2026,
        status: PayrollStatus.PAID,
        payslips: [
          {
            netPay: 5500,
            disbursementDate: new Date('2026-10-01'),
            employee: { employeeNumber: 'EMP-001', firstName: 'Ada', lastName: 'Lovelace' },
          },
        ],
      });

      const { csv, filename } = await service.getBankPaymentCsv('run-1');

      expect(filename).toBe('bank-payments-2026-09.csv');
      const lines = csv.split('\r\n');
      expect(lines[0]).toContain('employee_number');
      expect(lines[1]).toContain('EMP-001');
      expect(lines[1]).toContain('5500.00');
      expect(lines[1]).toContain('2026-10-01');
    });
  });

  describe('maker/checker approval', () => {
    it('throws NotFoundException for an unknown run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(null);

      await expect(service.approvePayrollRun('nope', 'checker-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('only DRAFT runs can be approved', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.APPROVED,
      });

      await expect(service.approvePayrollRun('run-1', 'checker-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('fails closed (403) when the creator cannot be resolved from the audit trail', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.DRAFT,
      });
      prismaService.auditLog.findFirst.mockResolvedValue(null);

      await expect(service.approvePayrollRun('run-1', 'checker-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks self-approval: approver must differ from the creator (403)', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.DRAFT,
      });
      prismaService.auditLog.findFirst.mockResolvedValue({ actorId: 'maker-1' });

      await expect(service.approvePayrollRun('run-1', 'maker-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('approves a DRAFT run by a different user, stamping approvedById (no disbursementDate)', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.DRAFT,
      });
      prismaService.auditLog.findFirst.mockResolvedValue({ actorId: 'maker-1' });
      prismaService.payrollRun.update.mockImplementation(({ data }: any) => ({
        id: 'run-1',
        ...data,
      }));

      const run = await service.approvePayrollRun('run-1', 'checker-1', 'checker@ems.local');

      expect(prismaService.payrollRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: PayrollStatus.APPROVED,
          approvedAt: expect.any(Date),
          approvedById: 'checker-1',
        }),
      });
      // Approval must NOT stamp disbursementDate (F15) — only disburse may.
      const updateData = prismaService.payrollRun.update.mock.calls[0][0].data;
      expect(updateData).not.toHaveProperty('disbursementDate');
      expect(prismaService.payslip.updateMany).toHaveBeenCalledWith({
        where: { payrollRunId: 'run-1' },
        data: { status: PayrollStatus.APPROVED },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.APPROVE, entityId: 'run-1' }),
      );
      expect(run.status).toBe(PayrollStatus.APPROVED);
    });
  });

  describe('disbursement transitions', () => {
    it('throws NotFoundException for an unknown run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(null);

      await expect(service.disbursePayrollRun('nope', 'checker-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects disbursement of a non-APPROVED run with 409', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(
        approvedRun({ status: PayrollStatus.DRAFT }),
      );

      await expect(service.disbursePayrollRun('run-1', 'checker-1')).rejects.toThrow(
        ConflictException,
      );
      expect(prismaService.payslip.updateMany).not.toHaveBeenCalled();
    });

    it('disburses an APPROVED run: PAID status + disbursementDate on payslips + per-payslip notifications', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(approvedRun());
      prismaService.payrollRun.update.mockImplementation(({ data }: any) => ({
        id: 'run-1',
        ...data,
      }));

      const result = await service.disbursePayrollRun('run-1', 'checker-1', 'checker@ems.local');

      // F10: the transition is conditional on the row still being APPROVED —
      // this is the atomic guard that serialises concurrent disburse calls.
      expect(prismaService.payrollRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1', status: PayrollStatus.APPROVED },
        data: { status: PayrollStatus.PAID },
      });
      expect(prismaService.payslip.updateMany).toHaveBeenCalledWith({
        where: { payrollRunId: 'run-1' },
        data: { status: PayrollStatus.PAID, disbursementDate: expect.any(Date) },
      });
      expect(result.status).toBe(PayrollStatus.PAID);
      expect(result.disbursementDate).toEqual(expect.any(String));
      // one notification job per payslip, with stable idempotency keys
      expect(queues.enqueueNotification).toHaveBeenCalledTimes(2);
      expect(queues.enqueueNotification).toHaveBeenCalledWith(
        'user-1',
        'in-app',
        'payslip-ready',
        expect.objectContaining({ payslipId: 'slip-1' }),
        expect.any(String),
        'payslip-ready:slip-1',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'PAYROLL_RUN_DISBURSE', entityId: 'run-1' }),
      );
    });

    it('re-disbursing a PAID run is a state no-op (idempotent)', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(
        approvedRun({ status: PayrollStatus.PAID }),
      );

      const result = await service.disbursePayrollRun('run-1', 'checker-1');

      expect(result.status).toBe(PayrollStatus.PAID);
      expect(prismaService.payrollRun.update).not.toHaveBeenCalled();
      expect(prismaService.payslip.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('read endpoints', () => {
    it('getSalaryStructures returns a paginated list', async () => {
      prismaService.salaryStructure.findMany.mockResolvedValue([{ id: 'ss-1' }]);
      prismaService.salaryStructure.count.mockResolvedValue(1);

      const res = await service.getSalaryStructures(1, 20);

      expect(res.data.items).toHaveLength(1);
      expect(res.data.meta.total).toBe(1);
    });

    it('getPayrollRuns returns a paginated list', async () => {
      prismaService.payrollRun.findMany.mockResolvedValue([{ id: 'run-1' }]);
      prismaService.payrollRun.count.mockResolvedValue(1);

      const res = await service.getPayrollRuns();

      expect(res.data.meta.total).toBe(1);
    });

    it('getPayrollRunById returns the run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: PayrollStatus.DRAFT,
      });

      const run = await service.getPayrollRunById('run-1');

      expect(run.id).toBe('run-1');
    });

    it('getEmployeeSalary returns the active assignment', async () => {
      prismaService.employeeSalaryStructure.findFirst.mockResolvedValue({ id: 'assign-1' });

      const assignment = await service.getEmployeeSalary('emp-1');

      expect(assignment.id).toBe('assign-1');
    });

    it('getPayslips returns a paginated list', async () => {
      prismaService.payslip.findMany.mockResolvedValue([{ id: 'slip-1' }]);
      prismaService.payslip.count.mockResolvedValue(1);

      const res = await service.getPayslips('emp-1');

      expect(res.data.meta.total).toBe(1);
      expect(prismaService.payslip.findMany.mock.calls[0][0].where.employeeId).toBe('emp-1');
    });

    it('getPayslipById returns the payslip or throws', async () => {
      prismaService.payslip.findUnique.mockResolvedValue({ id: 'slip-1' });
      expect((await service.getPayslipById('slip-1')).id).toBe('slip-1');

      prismaService.payslip.findUnique.mockResolvedValue(null);
      await expect(service.getPayslipById('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('salary structures & lookups', () => {
    it('createSalaryStructure defaults currency to GBP', async () => {
      prismaService.salaryStructure.create.mockImplementation(({ data }: any) => ({
        id: 'ss-1',
        ...data,
        components: data.components.create,
      }));

      const created = await service.createSalaryStructure(
        {
          name: 'Standard',
          components: [
            {
              name: 'Base',
              type: SalaryComponentType.EARNING,
              calculationType: CalculationType.FIXED,
              value: 4000,
            },
          ],
        } as any,
        'hr-1',
      );

      expect(created.currency).toBe('GBP');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'SALARY_STRUCTURE' }),
      );
    });

    it('getEmployeeSalary throws when no active structure exists', async () => {
      prismaService.employeeSalaryStructure.findFirst.mockResolvedValue(null);

      await expect(service.getEmployeeSalary('emp-1')).rejects.toThrow(NotFoundException);
    });

    it('getPayrollRunById throws for an unknown run', async () => {
      prismaService.payrollRun.findUnique.mockResolvedValue(null);

      await expect(service.getPayrollRunById('nope')).rejects.toThrow(NotFoundException);
    });

    it('assignSalary deactivates prior structures inside a transaction', async () => {
      prismaService.employeeSalaryStructure.create.mockImplementation(({ data }: any) => ({
        id: 'assign-1',
        ...data,
      }));

      const assignment = await service.assignSalary(
        {
          employeeId: 'emp-1',
          salaryStructureId: 'ss-1',
          baseSalary: 5500,
          effectiveFrom: '2026-10-01',
        } as any,
        'hr-1',
      );

      expect(prismaService.employeeSalaryStructure.updateMany).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1', isActive: true },
        data: { isActive: false },
      });
      expect(assignment.baseSalary).toBe(5500);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'EMPLOYEE_SALARY' }),
      );
    });
  });

  describe('payslip corrections', () => {
    const draftSlip = (overrides: Record<string, any> = {}) => ({
      id: 'slip-1',
      status: PayrollStatus.DRAFT,
      grossPay: 6000,
      totalDeductions: 500,
      netPay: 5500,
      breakdown: [
        { component: 'Base Salary', type: 'EARNING', amount: 6000 },
        { component: 'Tax', type: 'DEDUCTION', amount: 500 },
      ],
      payrollRun: { id: 'run-1', status: PayrollStatus.DRAFT, month: 9, year: 2026 },
      ...overrides,
    });

    beforeEach(() => {
      prismaService.payslip.update = jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'slip-1', ...data }));
    });

    it('appends an earning correction and re-derives totals in minor units', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(draftSlip());
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        payslips: [{ grossPay: 6150, totalDeductions: 500, netPay: 5650 }],
      });

      const updated: any = await service.addPayslipCorrection(
        'slip-1',
        {
          type: SalaryComponentType.EARNING,
          label: 'Overtime correction',
          amount: 150,
          reason: 'Missed OT',
        } as any,
        'hr-1',
        'hr@ems.local',
      );

      expect(Number(updated.grossPay)).toBe(6150);
      expect(Number(updated.netPay)).toBe(5650);
      expect(updated.breakdown).toHaveLength(3);
      expect(updated.breakdown[2]).toMatchObject({
        component: 'Overtime correction',
        correction: true,
        reason: 'Missed OT',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'PAYSLIP_CORRECTION', entityId: 'slip-1' }),
      );
      // run totals rolled up
      expect(prismaService.payrollRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: expect.objectContaining({ totalNet: 5650 }),
      });
    });

    it('appends a deduction correction and floors net at zero', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(
        draftSlip({ grossPay: 1000, totalDeductions: 0, netPay: 1000 }),
      );
      prismaService.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        payslips: [{ grossPay: 1000, totalDeductions: 5000, netPay: 0 }],
      });

      const updated: any = await service.addPayslipCorrection(
        'slip-1',
        {
          type: SalaryComponentType.DEDUCTION,
          label: 'Advance recovery',
          amount: 5000,
          reason: 'Salary advance',
        } as any,
        'hr-1',
      );

      expect(Number(updated.totalDeductions)).toBe(5000);
      expect(Number(updated.netPay)).toBe(0);
    });

    it('rejects corrections on non-DRAFT payslips', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(
        draftSlip({ status: PayrollStatus.APPROVED }),
      );

      await expect(
        service.addPayslipCorrection(
          'slip-1',
          { type: SalaryComponentType.EARNING, label: 'x', amount: 10, reason: 'y' } as any,
          'hr-1',
        ),
      ).rejects.toThrow(ConflictException);
      expect(prismaService.payslip.update).not.toHaveBeenCalled();
    });

    it('rejects corrections when the run is not DRAFT', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(
        draftSlip({ payrollRun: { id: 'run-1', status: PayrollStatus.PAID } }),
      );

      await expect(
        service.addPayslipCorrection(
          'slip-1',
          { type: SalaryComponentType.EARNING, label: 'x', amount: 10, reason: 'y' } as any,
          'hr-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException for unknown payslips', async () => {
      prismaService.payslip.findUnique.mockResolvedValue(null);

      await expect(
        service.addPayslipCorrection(
          'nope',
          { type: SalaryComponentType.EARNING, label: 'x', amount: 10, reason: 'y' } as any,
          'hr-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
