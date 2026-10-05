import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailQueueProducer } from './email-queue.producer';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, EmailQueueProducer],
  exports: [NotificationsService, EmailQueueProducer],
})
export class NotificationsModule {}
