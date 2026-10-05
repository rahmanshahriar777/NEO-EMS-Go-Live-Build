import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MALWARE_SCANNER, NoopMalwareScanner, ClamAvScanner } from './malware-scanner.interface';

@Module({
  imports: [NotificationsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    // Malware-scan hook: provides ClamAvScanner when DOCUMENT_MALWARE_SCAN_ENABLED=true,
    // otherwise NoopMalwareScanner. Fail-closed at runtime if scanner fails or finds threat.
    {
      provide: MALWARE_SCANNER,
      useFactory: (config: ConfigService) => {
        const enabled =
          (config.get<string>('DOCUMENT_MALWARE_SCAN_ENABLED') ?? 'false') === 'true';
        if (enabled) {
          const host = config.get<string>('CLAMAV_HOST') || 'localhost';
          const port = Number(config.get<number>('CLAMAV_PORT') || 3310);
          return new ClamAvScanner(host, port);
        }
        return new NoopMalwareScanner();
      },
      inject: [ConfigService],
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
