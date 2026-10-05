import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// QueueService (email copies via the live `notifications` queue, channel
// 'email') comes from the @Global() QueuesModule. The old standalone
// `email`-queue producer was deleted (go-live HIGH #2) — it had no consumer.
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
