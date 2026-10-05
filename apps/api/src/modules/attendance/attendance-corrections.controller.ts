import { Controller, Get, Post, Patch, Param, Body, Query, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { CreateAttendanceCorrectionDto, DecideAttendanceCorrectionDto } from './dto/attendance.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';

/**
 * Attendance correction requests — employee requests, manager/HR decides.
 *
 * Separate controller file (worker 3) so these routes are independent of
 * concurrent edits to attendance.controller.ts. Implements the exact contract
 * the web UI calls:
 *   POST /attendance/corrections        { attendanceRecordId, requestedClockIn?,
 *                                         requestedClockOut?, reason }
 *   GET  /attendance/corrections?status=  (scoped: own for employees,
 *                                          team+self for managers, all for HR)
 *   PATCH /attendance/corrections/:id   { status: 'APPROVED' | 'REJECTED' }
 * Corrections are stored in a Redis-backed interim store (no
 * attendance_corrections table exists yet — worker 4).
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance/corrections')
export class AttendanceCorrectionsController {
  constructor(private readonly corrections: AttendanceCorrectionsService) {}

  @Post()
  @ApiOperation({ summary: 'Request a correction to an attendance record' })
  async create(@Body() dto: CreateAttendanceCorrectionDto, @CurrentUser() user: JwtPayload) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee record');
    }
    return this.corrections.create(user.employeeId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List correction requests (role-scoped)' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  async list(
    @Query('status') status: 'PENDING' | 'APPROVED' | 'REJECTED' | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.corrections.list(
      { userId: user.sub, employeeId: user.employeeId, roles: user.roles },
      status,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Approve or reject a correction request (manager of employee or HR)' })
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideAttendanceCorrectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.corrections.decide(id, dto.status, {
      userId: user.sub,
      employeeId: user.employeeId,
      roles: user.roles,
    });
  }
}
