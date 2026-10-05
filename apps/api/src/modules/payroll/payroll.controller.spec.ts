/**
 * PayrollController wiring tests — delegation, actor propagation, and the
 * controller-level payslip access rules (HR/admin see all; employees see
 * only their own). Guard behavior is covered by
 * common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { SystemRole, JwtPayload } from '@ems/shared';

const user = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'hr@ems.local',
  roles: [SystemRole.HR_ADMIN],
  permissions: [],
  employeeId: 'emp-hr',
  ...overrides,
});

describe('PayrollController', () => {
  let controller: PayrollController;
  let service: any;

  beforeEach(async () => {
    service = {
      getSalaryStructures: jest.fn(),
      createSalaryStructure: jest.fn(),
      getEmployeeSalary: jest.fn(),
      assignSalary: jest.fn(),
      createPayrollRun: jest.fn(),
      getPayrollRuns: jest.fn(),
      getPayrollRunById: jest.fn(),
      approvePayrollRun: jest.fn(),
      disbursePayrollRun: jest.fn(),
      cancelPayrollRun: jest.fn(),
      recalculatePayrollRun: jest.fn(),
      getBankPaymentCsv: jest.fn(),
      getPayslips: jest.fn(),
      getPayslipById: jest.fn(),
      getPayslipPdf: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayrollController],
      providers: [{ provide: PayrollService, useValue: service }],
    }).compile();

    controller = module.get<PayrollController>(PayrollController);
  });

  it('createPayrollRun propagates the actor identity', async () => {
    service.createPayrollRun.mockResolvedValue({ id: 'run-1' });
    const dto = { month: 9, year: 2026 };

    await controller.createPayrollRun(dto as any, user());

    expect(service.createPayrollRun).toHaveBeenCalledWith(dto, 'user-1', 'hr@ems.local');
  });

  it('approvePayrollRun and disbursePayrollRun propagate the actor identity', async () => {
    service.approvePayrollRun.mockResolvedValue({ id: 'run-1' });
    service.disbursePayrollRun.mockResolvedValue({ id: 'run-1' });

    await controller.approvePayrollRun('run-1', user());
    expect(service.approvePayrollRun).toHaveBeenCalledWith('run-1', 'user-1', 'hr@ems.local');

    await controller.disbursePayrollRun('run-1', user());
    expect(service.disbursePayrollRun).toHaveBeenCalledWith('run-1', 'user-1', 'hr@ems.local');
  });

  it('assignSalary merges the path employeeId into the dto', async () => {
    service.assignSalary.mockResolvedValue({ id: 'assign-1' });

    await controller.assignSalary('emp-9', { salaryStructureId: 'ss-1', baseSalary: 5000 } as any, user());

    expect(service.assignSalary).toHaveBeenCalledWith(
      { salaryStructureId: 'ss-1', baseSalary: 5000, employeeId: 'emp-9' },
      'user-1',
      'hr@ems.local',
    );
  });

  it('getPayslips: employees are coerced to their own employeeId', async () => {
    service.getPayslips.mockResolvedValue({ data: { items: [] } });
    const emp = user({ roles: [SystemRole.EMPLOYEE], employeeId: 'emp-1' });

    // Attempting to read another employee's payslips is coerced to self.
    await controller.getPayslips(emp, 'emp-999', undefined, 1, 20);
    expect(service.getPayslips).toHaveBeenCalledWith('emp-1', undefined, 1, 20);

    // Employees without a linked profile are rejected.
    expect(() =>
      controller.getPayslips(user({ roles: [SystemRole.EMPLOYEE], employeeId: undefined }), undefined, undefined, 1, 20),
    ).toThrow(ForbiddenException);
  });

  it('getPayslips: HR may filter by any employeeId', async () => {
    service.getPayslips.mockResolvedValue({ data: { items: [] } });

    await controller.getPayslips(user(), 'emp-999', 'run-1', 2, 200);

    expect(service.getPayslips).toHaveBeenCalledWith('emp-999', 'run-1', 2, 100);
  });

  it('getPayslipById: employees cannot read other employees payslips', async () => {
    service.getPayslipById.mockResolvedValue({ id: 'slip-1', employeeId: 'emp-999' });
    const emp = user({ roles: [SystemRole.EMPLOYEE], employeeId: 'emp-1' });

    await expect(controller.getPayslipById('slip-1', emp)).rejects.toThrow(ForbiddenException);

    service.getPayslipById.mockResolvedValue({ id: 'slip-2', employeeId: 'emp-1' });
    await expect(controller.getPayslipById('slip-2', emp)).resolves.toEqual({
      id: 'slip-2',
      employeeId: 'emp-1',
    });
  });

  it('getBankPaymentCsv sets download headers and sends the csv', async () => {
    service.getBankPaymentCsv.mockResolvedValue({ csv: 'a,b\n1,2', filename: 'pay.csv' });
    const res: any = { setHeader: jest.fn(), send: jest.fn() };

    await controller.getBankPaymentCsv('run-1', res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="pay.csv"');
    expect(res.send).toHaveBeenCalledWith('a,b\n1,2');
  });

  it('getPayslipPdf enforces the same self-access rule and sends the pdf', async () => {
    service.getPayslipById.mockResolvedValue({ id: 'slip-1', employeeId: 'emp-999' });
    service.getPayslipPdf.mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'slip.pdf' });
    const res: any = { setHeader: jest.fn(), send: jest.fn() };
    const emp = user({ roles: [SystemRole.EMPLOYEE], employeeId: 'emp-1' });

    await expect(controller.getPayslipPdf('slip-1', emp, res)).rejects.toThrow(ForbiddenException);

    service.getPayslipById.mockResolvedValue({ id: 'slip-1', employeeId: 'emp-1' });
    await controller.getPayslipPdf('slip-1', emp, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('pdf'));
  });
});
