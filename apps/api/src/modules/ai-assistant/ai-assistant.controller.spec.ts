/**
 * AiAssistantController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './ai-assistant.service';
import { SystemRole } from '@ems/shared';

describe('AiAssistantController', () => {
  let controller: AiAssistantController;
  let service: any;

  const user: any = {
    sub: 'user-1',
    email: 'u@ems.local',
    employeeId: 'emp-1',
    roles: [SystemRole.EMPLOYEE],
  };
  const actor = {
    userId: 'user-1',
    employeeId: 'emp-1',
    email: 'u@ems.local',
    roles: [SystemRole.EMPLOYEE],
  };

  beforeEach(async () => {
    service = { ask: jest.fn(), runAction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiAssistantController],
      providers: [{ provide: AiAssistantService, useValue: service }],
    }).compile();

    controller = module.get<AiAssistantController>(AiAssistantController);
  });

  it('ask forwards the role-scoped actor + dto', () => {
    service.ask.mockReturnValue({ answer: 'hi', citations: [] });
    const dto: any = { question: 'How much leave do I have?' };
    controller.ask(dto, user);
    expect(service.ask).toHaveBeenCalledWith(actor, dto);
  });

  it('runAction forwards the role-scoped actor + dto', () => {
    service.runAction.mockReturnValue({ draft: {} });
    const dto: any = { action: 'draft-leave-request', args: {} };
    controller.runAction(dto, user);
    expect(service.runAction).toHaveBeenCalledWith(actor, dto);
  });
});
