import { Module } from '@nestjs/common';
import { RosteringController } from './rostering.controller';
import { RosteringService } from './rostering.service';

@Module({
  controllers: [RosteringController],
  providers: [RosteringService],
  exports: [RosteringService],
})
export class RosteringModule {}
