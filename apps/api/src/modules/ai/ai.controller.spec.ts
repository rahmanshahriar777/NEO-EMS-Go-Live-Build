/**
 * AiController + AuditController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AiController } from './ai.controller';
import { AiOrchestratorService } from './orchestrator/ai-orchestrator.service';
import { AiAuditService } from './audit/ai-audit.service';

describe('AiController', () => {
  let controller: AiController;
  let orchestrator: any;
  let auditService: any;

  beforeEach(async () => {
    orchestrator = { generate: jest.fn(), getHealthStatus: jest.fn() };
    auditService = { getRecentLogs: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiOrchestratorService, useValue: orchestrator },
        { provide: AiAuditService, useValue: auditService },
      ],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  it('generate forwards prompt + options and derives the actor from the request user', async () => {
    orchestrator.generate.mockResolvedValue({ text: 'hi' });
    const req: any = { user: { sub: 'user-1', email: 'hr@ems.local' } };

    const result = await controller.generate(
      { prompt: 'Summarise', model: 'm', temperature: 0.2, maxTokens: 100 } as any,
      req,
    );

    expect(orchestrator.generate).toHaveBeenCalledWith(
      'Summarise',
      { model: 'm', temperature: 0.2, maxTokens: 100 },
      { id: 'user-1', email: 'hr@ems.local' },
    );
    expect(result).toEqual({ text: 'hi' });
  });

  it('generate passes no actor when the request has no user', async () => {
    orchestrator.generate.mockResolvedValue({ text: 'hi' });

    await controller.generate({ prompt: 'p' } as any, {});

    expect(orchestrator.generate).toHaveBeenCalledWith('p', expect.anything(), undefined);
  });

  it('getHealth delegates to the orchestrator', async () => {
    orchestrator.getHealthStatus.mockResolvedValue({ status: 'UP' });

    await expect(controller.getHealth()).resolves.toEqual({ status: 'UP' });
  });

  it('getLogs coerces the limit and defaults to 20', async () => {
    auditService.getRecentLogs.mockResolvedValue([]);

    await controller.getLogs('5' as any);
    expect(auditService.getRecentLogs).toHaveBeenCalledWith(5);

    await controller.getLogs(undefined as any);
    expect(auditService.getRecentLogs).toHaveBeenCalledWith(20);
  });
});
