import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceCorrectionsController } from './attendance-corrections.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceCorrectionsService } from './attendance-corrections.service';

@Module({
  controllers: [AttendanceController, AttendanceCorrectionsController],
  providers: [AttendanceService, AttendanceCorrectionsService],
  exports: [AttendanceService, AttendanceCorrectionsService],
})
export class AttendanceModule {}
