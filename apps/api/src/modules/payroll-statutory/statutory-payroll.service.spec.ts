import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StatutoryPayrollService } from './statutory-payroll.service';
import { SandboxStatutoryPayrollProvider } from './sandbox.provider';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { PayrollStatus } from '@ems/shared';

describe('StatutoryPayrollService', () => {
  let service: StatutoryPayrollService;
  let prisma: any;
  let audit: any;

  const build = async (providerName = 'sandbox') => {
    prisma = {
      payrollRun: { findUnique: jest.fn() },
      auditLog: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    audit = { log: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatutoryPayrollService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => (k === 'STATUTORY_PAYROLL_PROVIDER' ? providerName : undefined)) },
        },
      ],
    }).compile();
    service = module.get<StatutoryPayrollService>(StatutoryPayrollService);
  };

  it('fails closed on an unknown provider name', async () => {
    await build('nonexistent-provider');
    expect(() => service.getProvider()).toThrow(/Unknown statutory payroll provider/);
  });

  it('resolves the sandbox provider by default', async () => {
    await build('sandbox');
    const provider = service.getProvider();
    expect(provider.name).toBe('sandbox');
    expect(provider.isSandbox).toBe(true);
  });

  it('refuses to submit DRAFT runs', async () => {
    await build('sandbox');
    prisma.payrollRun.findUnique.mockResolvedValue({ id: 'run-1', status: PayrollStatus.DRAFT });

    await expect(service.submitRun('run-1', 'hr-1')).rejects.toThrow(/Only APPROVED or PAID/);
  });

  it('submits an APPROVED run via the provider and records an audit row', async () => {
    await build('sandbox');
    prisma.payrollRun.findUnique.mockResolvedValue({
      id: 'run-1',
      month: 9,
      year: 2026,
      status: PayrollStatus.APPROVED,
      totalGross: 10000,
      totalDeductions: 2000,
      totalNet: 8000,
      payslips: [
        { employeeId: 'emp-1', grossPay: 10000, totalDeductions: 2000, netPay: 8000, employee: { employeeNumber: 'EMP-1' } },
      ],
    });

    const receipt = await service.submitRun('run-1', 'hr-1', 'hr@ems.local');

    expect(receipt.sandbox).toBe(true);
    expect(receipt.provider).toBe('sandbox');
    expect(receipt.submissionId).toMatch(/^sandbox-/);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'STATUTORY_SUBMISSION', entityId: receipt.submissionId }),
    );
  });

  it('reports sandbox status as simulated acceptance', async () => {
    await build('sandbox');
    const provider = service.getProvider();
    const receipt = await provider.submitPayroll({
      payrollRunId: 'run-1',
      period: { month: 9, year: 2026 },
      submittedByUserId: 'hr-1',
      currency: 'GBP',
      employees: [{ employeeId: 'e1', employeeNumber: 'EMP-1', grossPay: 1, totalDeductions: 0, netPay: 1 }],
      totals: { grossPay: 1, totalDeductions: 0, netPay: 1 },
    });
    const status = await provider.getSubmissionStatus(receipt.submissionId);
    expect(status.status).toBe('ACCEPTED');
    expect(status.detail).toMatch(/SANDBOX ONLY/);
  });

  it('sandbox refuses empty submissions', async () => {
    const provider = new SandboxStatutoryPayrollProvider();
    await expect(
      provider.submitPayroll({
        payrollRunId: 'run-1',
        period: { month: 9, year: 2026 },
        submittedByUserId: 'hr-1',
        currency: 'GBP',
        employees: [],
        totals: { grossPay: 0, totalDeductions: 0, netPay: 0 },
      }),
    ).rejects.toThrow(/empty submission/);
  });
});
