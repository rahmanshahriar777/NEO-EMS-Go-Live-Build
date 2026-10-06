import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ACCESS_POLICY } from './access-policy';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';

/**
 * Dashboard module (Phase 2 item 1).
 *
 * Unified access policy: binds ACCESS_POLICY to the canonical AccessPolicyService.
 */
@Module({
  controllers: [DashboardController],
  providers: [
    DashboardService,
    { provide: ACCESS_POLICY, useExisting: AccessPolicyService },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
