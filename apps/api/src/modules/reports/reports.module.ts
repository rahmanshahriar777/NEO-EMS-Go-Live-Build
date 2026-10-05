import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Reporting & exports (Phase 3 item 2).
 *
 * Scheduled delivery hook: worker 4's cron calls
 * ReportsService.runScheduledReports() (schedules from REPORT_SCHEDULES env;
 * ReportSchedule table is a schema-worker follow-up). Report emails go
 * through the live `notifications` queue (channel 'email') via the @Global()
 * QueueService — the old standalone `email` queue (no consumer) is deleted.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
