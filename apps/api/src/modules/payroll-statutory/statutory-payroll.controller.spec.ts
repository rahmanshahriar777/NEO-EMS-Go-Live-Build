/**
 * StatutoryPayrollController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { StatutoryPayrollController } from './statutory-payroll.controller';
import { StatutoryPayrollService } from './statutory-payroll.service';

describe('StatutoryPayrollController', () => {
  let controller: StatutoryPayrollController;
  let service: any;

  const user: any = { sub: 'hr-1', email: 'hr@ems.local' };

  beforeEach(async () => {
    service = {
      submitRun: jest.fn(),
      listSubmissions: jest.fn(),
      getSubmissionStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatutoryPayrollController],
      providers: [{ provide: StatutoryPayrollService, useValue: service }],
    }).compile();

    controller = module.get<StatutoryPayrollController>(StatutoryPayrollController);
  });

  it('submitRun forwards run id + actor identity', () => {
    service.submitRun.mockReturnValue({ submissionId: 'sub-1' });
    controller.submitRun('run-1', user);
    expect(service.submitRun).toHaveBeenCalledWith('run-1', 'hr-1', 'hr@ems.local');
  });

  it('listSubmissions defaults page=1, clamps limit to 100', () => {
    service.listSubmissions.mockReturnValue([]);
    controller.listSubmissions(undefined, undefined);
    expect(service.listSubmissions).toHaveBeenCalledWith(1, 20);

    controller.listSubmissions(3, 500);
    expect(service.listSubmissions).toHaveBeenCalledWith(3, 100);
  });

  it('getSubmissionStatus forwards the id', () => {
    service.getSubmissionStatus.mockReturnValue({ status: 'SUBMITTED' });
    controller.getSubmissionStatus('sub-1');
    expect(service.getSubmissionStatus).toHaveBeenCalledWith('sub-1');
  });
});
