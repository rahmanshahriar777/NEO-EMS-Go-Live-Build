import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiOrchestratorService } from './orchestrator/ai-orchestrator.service';
import { AiAuditService } from './audit/ai-audit.service';
import { AIProviderFactory } from './providers/ai-provider.factory';
import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuditModule } from '../../core/audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AiController],
  providers: [
    GeminiProvider,
    GroqProvider,
    AIProviderFactory,
    AiAuditService,
    AiOrchestratorService,
  ],
  exports: [AiOrchestratorService, AiAuditService, AIProviderFactory],
})
export class AiModule {}
