import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { NotificationsModule } from '../notifications/notifications.module';
import { FieldReportsController } from './field-reports.controller';
import { DownloadGrantGuard } from './guards/download-grant.guard';
import { FieldReportFeatureGuard } from './guards/field-report-feature.guard';
import { DownloadGrantService } from './services/download-grant.service';
import { FieldReportAccessService } from './services/field-report-access.service';
import { FieldReportPolicyService } from './services/field-report-policy.service';
import { FieldReportsStorageService } from './services/field-reports-storage.service';
import { FieldReportsService } from './services/field-reports.service';
import { UploadSessionService } from './services/upload-session.service';

@Module({
  imports: [JwtModule.register({}), NotificationsModule],
  controllers: [FieldReportsController],
  providers: [
    FieldReportFeatureGuard,
    DownloadGrantGuard,
    FieldReportsStorageService,
    FieldReportAccessService,
    FieldReportPolicyService,
    UploadSessionService,
    DownloadGrantService,
    FieldReportsService,
  ],
  exports: [
    FieldReportsService,
    FieldReportAccessService,
    FieldReportPolicyService,
    DownloadGrantService,
  ],
})
export class FieldReportsModule {}

