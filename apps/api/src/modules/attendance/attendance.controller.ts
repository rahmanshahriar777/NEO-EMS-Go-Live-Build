import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AttendanceService, AttendanceViewer } from './attendance.service';
import {
  ClockInDto,
  ClockOutDto,
  AttendanceQueryDto,
  ReviewCorrectionDto,
} from './dto/attendance.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  private toViewer(user: JwtPayload): AttendanceViewer {
    return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
  }

  @Post('clock-in')
  @ApiOperation({ summary: 'Clock in for the current working day (employee timezone)' })
  async clockIn(@Body() dto: ClockInDto, @CurrentUser() user: JwtPayload) {
    const targetEmployeeId =
      dto.employeeId && user.roles.includes(SystemRole.SUPER_ADMIN)
        ? dto.employeeId
        : user.employeeId;

    if (!targetEmployeeId) {
      throw new ForbiddenException('User is not associated with an employee record');
    }

    const record = await this.service.clockIn(targetEmployeeId, dto);
    return {
      success: true,
      message: 'Clocked in successfully',
      data: record,
    };
  }

  @Post('clock-out')
  @ApiOperation({ summary: 'Clock out (computes breaks + overtime from roster/shift)' })
  async clockOut(@Body() dto: ClockOutDto, @CurrentUser() user: JwtPayload) {
    const targetEmployeeId =
      dto.employeeId && user.roles.includes(SystemRole.SUPER_ADMIN)
        ? dto.employeeId
        : user.employeeId;

    if (!targetEmployeeId) {
      throw new ForbiddenException('User is not associated with an employee record');
    }

    const record = await this.service.clockOut(targetEmployeeId, dto);
    return {
      success: true,
      message: 'Clocked out successfully',
      data: record,
    };
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current employee attendance history and status' })
  async getMyAttendance(@CurrentUser() user: JwtPayload, @Query() query: AttendanceQueryDto) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee record');
    }
    return this.service.getMyAttendance(user.employeeId, query);
  }

  @Get('team')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get team attendance records for line managers' })
  async getTeamAttendance(@CurrentUser() user: JwtPayload, @Query() query: AttendanceQueryDto) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee record');
    }
    return this.service.getTeamAttendance(user.employeeId, query);
  }

  @Get('reports')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get organization-wide attendance reports' })
  async getReports(@Query() query: AttendanceQueryDto) {
    return this.service.getReports(query);
  }

  // NOTE (worker 3): the canonical GET/POST/PATCH /attendance/corrections
  // handlers live in AttendanceCorrectionsController
  // (attendance-corrections.controller.ts) — kept in a separate file so they
  // are independent of edits to this controller. They implement the exact
  // contract the web UI calls
  // ({ attendanceRecordId, requestedClockIn?, requestedClockOut?, reason })
  // and work today via a Redis-backed interim store, because the
  // attendance_corrections TABLE does not exist yet (worker 4). The
  // table-backed AttendanceService.requestCorrection()/listCorrections()
  // methods remain available and can be re-wired once that migration lands.

  @Patch('corrections/:id/review')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve/reject an attendance correction (manager of employee or HR)' })
  async reviewCorrection(
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.reviewCorrection(id, this.toViewer(user), dto);
  }
}
