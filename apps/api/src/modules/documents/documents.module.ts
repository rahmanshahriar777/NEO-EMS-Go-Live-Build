import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MALWARE_SCANNER, NoopMalwareScanner } from './malware-scanner.interface';

@Module({
  imports: [NotificationsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    // Malware-scan hook (Phase 1 hardening): the no-op is the default.
    // Production registers a ClamAV-backed scanner here instead; the service
    // fail-closes at boot when DOCUMENT_MALWARE_SCAN_ENABLED=true and the
    // registered scanner is still the no-op.
    { provide: MALWARE_SCANNER, useClass: NoopMalwareScanner },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
