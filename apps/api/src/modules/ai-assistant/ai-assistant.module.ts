import { Module } from '@nestjs/common';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './ai-assistant.service';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../../core/audit/audit.module';
import { AccessPolicyModule } from '../../core/access-policy/access-policy.module';

/**
 * Phase 3, item 4 — grounded AI assistant. Reuses AiModule's exported
 * AiOrchestratorService for generation (PII redaction, model allowlist,
 * daily budgets, circuit breakers all inherited).
 */
@Module({
  imports: [AiModule, AuditModule, AccessPolicyModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService],
})
export class AiAssistantModule {}
