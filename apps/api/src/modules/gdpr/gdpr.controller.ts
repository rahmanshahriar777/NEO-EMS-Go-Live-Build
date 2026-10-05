import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GdprService } from './gdpr.service';
import {
  CreateErasureRequestDto,
  ErasureRequestQueryDto,
  PurgeRetentionDto,
  ReviewErasureRequestDto,
} from './dto/gdpr.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload, SystemRole } from '@ems/shared';

// NOTE on @Permissions(): intentionally NOT attached here. The seed mints the
// permission matrix but assigns zero permissions to any role, so attaching
// @Permissions() metadata today would deny every non-SUPER_ADMIN caller
// (see the decision note in app.module.ts). Enforcement uses @Roles(); attach
// e.g. @Permissions('GDPR:ERASURE_REVIEW') once role -> permission grants are
// seeded.
// NOTE (B1): JwtAuthGuard + RolesGuard are global; per-controller duplication removed.
@ApiTags('GDPR')
@ApiBearerAuth()
@Controller('gdpr')
export class GdprController {
  constructor(private readonly service: GdprService) {}

  @Post('erasure-requests')
  @ApiOperation({
    summary: 'Request erasure of your own employee data (one pending request at a time)',
  })
  createErasureRequest(
    @Body() dto: CreateErasureRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.createErasureRequest(user, dto);
  }

  @Get('erasure-requests')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List erasure requests (HR/admin, paginated)' })
  listErasureRequests(@Query() query: ErasureRequestQueryDto) {
    return this.service.listErasureRequests(query);
  }

  @Post('erasure-requests/:id/review')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Review an erasure request: APPROVE anonymises the employee (payroll/attendance history preserved), REJECT requires a reason',
  })
  reviewErasureRequest(
    @Param('id') id: string,
    @Body() dto: ReviewErasureRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.reviewErasureRequest(id, user, dto);
  }

  @Get('export')
  @ApiOperation({
    summary: 'DSAR self-export: everything the system holds about the caller (never other users)',
  })
  exportMyData(
    @CurrentUser() user: JwtPayload,
    @Query('attendancePage') attendancePage?: string,
    @Query('attendanceLimit') attendanceLimit?: string,
  ) {
    const page = Math.max(1, parseInt(attendancePage ?? '1', 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(attendanceLimit ?? '100', 10) || 100));
    return this.service.exportMyData(user, { attendancePage: page, attendanceLimit: limit });
  }

  @Get('retention/schedule')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'View the per-entity retention schedule and counsel sign-off status',
    description:
      'Every retention window is a PLACEHOLDER pending counsel sign-off. ' +
      'The purge job is forced into dry-run until GDPR_RETENTION_SIGNED_OFF=true.',
  })
  getRetentionSchedule() {
    return this.service.getRetentionSchedule();
  }

  @Get('retention/preview')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Dry-run preview of the retention purge: per-entity counts of what would be deleted',
  })
  previewRetentionPurge() {
    return this.service.previewRetentionPurge();
  }

  @Post('retention/purge')
  @Roles(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Run the retention purge (dry-run unless dryRun:false AND counsel sign-off recorded)',
    description:
      'Defaults to dry-run (counts + logs only). Real deletes require an ' +
      'explicit dryRun:false AND GDPR_RETENTION_SIGNED_OFF=true. Statutory ' +
      'entities are never deleted by this job.',
  })
  purgeRetention(@Body() dto: PurgeRetentionDto) {
    return this.service.purgeExpiredRetention({ dryRun: dto.dryRun });
  }
}
