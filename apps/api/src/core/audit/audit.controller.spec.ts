/**
 * AuditController wiring tests — pagination clamping and delegation.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

describe('AuditController', () => {
  let controller: AuditController;
  let audit: any;

  beforeEach(async () => {
    audit = { getLogs: jest.fn(), verifyChain: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: audit }],
    }).compile();

    controller = module.get<AuditController>(AuditController);
  });

  it('getLogs defaults the page and clamps the limit', async () => {
    audit.getLogs.mockResolvedValue({ data: { items: [] } });

    await controller.getLogs(undefined, undefined, undefined, undefined);
    expect(audit.getLogs).toHaveBeenCalledWith(undefined, undefined, 1, 50);

    await controller.getLogs('PAYROLL_RUN', 'run-1', 2, 500);
    expect(audit.getLogs).toHaveBeenCalledWith('PAYROLL_RUN', 'run-1', 2, 200);
  });

  it('verifyChain defaults the batch size to 500', async () => {
    audit.verifyChain.mockResolvedValue({ valid: true });

    await controller.verifyChain(undefined, undefined);
    expect(audit.verifyChain).toHaveBeenCalledWith(500, { allowTruncation: false });

    await controller.verifyChain(100, 'true');
    expect(audit.verifyChain).toHaveBeenCalledWith(100, { allowTruncation: true });
  });
});
