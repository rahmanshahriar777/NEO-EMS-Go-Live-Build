import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

/**
 * Integrations (Phase 3 item 5): leave iCal feed, Slack/Teams webhook alerts,
 * accounting CSV export. (Google/Microsoft OAuth sign-in is worker 1's.)
 */
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
