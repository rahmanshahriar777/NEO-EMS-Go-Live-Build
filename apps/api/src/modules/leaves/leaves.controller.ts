import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ForbiddenException,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LeavesService, toLeaveViewer } from './leaves.service';
import {
  CreateLeaveRequestDto,
  ApproveLeaveDto,
  CreateLeaveTypeDto,
  CreateHolidayDto,
  CreateLeavePolicyDto,
} from './dto/leave.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload, LeaveStatus } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
// NOTE on PBAC: @Permissions() metadata is deliberately NOT attached (see the
// note in documents.controller.ts): the seed currently grants zero
// permissions to any role, so attaching metadata would lock out every
// non-SUPER_ADMIN user. Attach once role -> permission grants are seeded.
@ApiTags('Leaves & Holidays')
@ApiBearerAuth()
@Controller()
export class LeavesController {
  constructor(private readonly service: LeavesService) {}

  @Get('leave-types')
  @ApiOperation({ summary: 'List all configured leave types' })
  getLeaveTypes() {
    return this.service.getLeaveTypes();
  }

  @Post('leave-types')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a new leave type' })
  createLeaveType(@Body() dto: CreateLeaveTypeDto, @CurrentUser() user: JwtPayload) {
    return this.service.createLeaveType(dto, user.sub, user.email);
  }

  @Get('leave-policies')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @ApiOperation({ summary: 'List leave policies (accrual, carry-over, working week)' })
  getLeavePolicies() {
    return this.service.getLeavePolicies();
  }

  @Post('leave-policies')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create or update a leave policy for a leave type' })
  upsertLeavePolicy(@Body() dto: CreateLeavePolicyDto, @CurrentUser() user: JwtPayload) {
    return this.service.upsertLeavePolicy(dto, user.sub, user.email);
  }

  @Post('leave-policies/carry-over')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Apply annual carry-over from one year to the next (HR)' })
  applyCarryOver(
    @Body() body: { fromYear: number; toYear: number },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.applyAnnualCarryOver(body.fromYear, body.toYear, user.sub, user.email);
  }

  @Get('leave-balances')
  @ApiOperation({ summary: 'Get current leave balances' })
  getLeaveBalances(
    @CurrentUser() user: JwtPayload,
    @Query('employeeId') employeeId?: string,
    @Query('year') year?: string,
  ) {
    const targetEmpId = employeeId && (user.roles.includes(SystemRole.HR_ADMIN) || user.roles.includes(SystemRole.SUPER_ADMIN))
      ? employeeId
      : user.employeeId;

    if (!targetEmpId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }

    const targetYear = year ? parseInt(year, 10) : new Date().getFullYear();
    return this.service.getEmployeeBalances(targetEmpId, targetYear);
  }

  @Post('leave-balances/:id/reconcile')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Reconcile a leave balance against approved/pending requests (admin)',
    description:
      'Recomputes used/pending/remaining days from the source-of-truth leave requests, ' +
      'restoring the invariant remaining = allocated − used − pending.',
  })
  reconcileBalance(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.reconcileBalance(id, user.sub, user.email);
  }

  @Post('leave-requests')
  @ApiOperation({
    summary: 'Submit a new leave request (working days only; cross-year requests split)',
  })
  createLeaveRequest(@Body() dto: CreateLeaveRequestDto, @CurrentUser() user: JwtPayload) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }
    return this.service.createLeaveRequest(user.employeeId, dto);
  }

  @Get('leave-requests')
  @ApiOperation({ summary: 'List leave requests (scoped: HR all, manager team+self, employee self)' })
  getLeaveRequests(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: LeaveStatus,
    @Query('employeeId') employeeId?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.getLeaveRequests(toLeaveViewer(user), {
      status,
      employeeId,
      page: page ?? 1,
      limit: Math.min(limit ?? 20, 100),
    });
  }

  @Get('leave-requests/:id')
  @ApiOperation({ summary: 'Get leave request details (ownership-checked)' })
  getLeaveRequestById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.getLeaveRequestById(id, toLeaveViewer(user));
  }

  @Patch('leave-requests/:id/approve')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Approve a pending leave request (A2: requester\u2019s manager or HR; B4: approver USER id audited)',
  })
  approveLeave(
    @Param('id') id: string,
    @Body() dto: ApproveLeaveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }
    return this.service.approveOrReject(
      id,
      user.employeeId,
      { status: LeaveStatus.APPROVED, remarks: dto.remarks },
      user.email,
      user.sub,
      user.roles,
    );
  }

  @Patch('leave-requests/:id/reject')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reject a pending leave request (A2: requester\u2019s manager or HR; B4: approver USER id audited)',
  })
  rejectLeave(
    @Param('id') id: string,
    @Body() dto: ApproveLeaveDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }
    return this.service.approveOrReject(
      id,
      user.employeeId,
      { status: LeaveStatus.REJECTED, remarks: dto.remarks },
      user.email,
      user.sub,
      user.roles,
    );
  }

  @Post('leave-requests/:id/submit')
  @ApiOperation({ summary: 'Submit a DRAFT leave request (owner only): validates, reserves balance, moves to PENDING' })
  submitLeave(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }
    return this.service.submitLeaveRequest(id, user.employeeId, {
      userId: user.sub,
      email: user.email,
    });
  }

  @Patch('leave-requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel an owned pending leave request (or approved, by owner/manager/HR)' })
  cancelLeave(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    }
    return this.service.cancelLeave(id, user.employeeId, { userId: user.sub, roles: user.roles });
  }

  @Get('holidays')
  @ApiOperation({ summary: 'List company and statutory holidays' })
  getHolidays() {
    return this.service.getHolidays();
  }

  @Post('holidays')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a company holiday' })
  createHoliday(@Body() dto: CreateHolidayDto) {
    return this.service.createHoliday(dto);
  }
}
