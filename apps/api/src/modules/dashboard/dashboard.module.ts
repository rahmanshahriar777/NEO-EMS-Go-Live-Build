import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ACCESS_POLICY, LocalAccessPolicyService } from './access-policy';

/**
 * Dashboard module (Phase 2 item 1).
 *
 * ACCESS_POLICY provider swap contract: worker 2's
 * `apps/api/src/core/access-policy/` module is not landed yet, so we bind the
 * documented `can(viewer, targetEmployeeId, action)` interface to the local
 * fail-closed fallback. When the core module lands, change this provider to
 * the real AccessPolicyService — dashboard code needs no other changes.
 */
@Module({
  controllers: [DashboardController],
  providers: [
    DashboardService,
    { provide: ACCESS_POLICY, useClass: LocalAccessPolicyService },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
