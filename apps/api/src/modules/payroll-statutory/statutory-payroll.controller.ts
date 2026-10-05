import { Controller, Get, Post, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StatutoryPayrollService } from './statutory-payroll.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

@ApiTags('Statutory Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
@Controller('payroll-statutory')
export class StatutoryPayrollController {
  constructor(private readonly service: StatutoryPayrollService) {}

  @Post('runs/:runId/submit')
  @ApiOperation({
    summary: 'Submit an approved/paid run to the statutory payroll provider',
    description:
      'Provider is selected by STATUTORY_PAYROLL_PROVIDER (default: sandbox — ' +
      'NOT a real filing). Only APPROVED/PAID runs may be submitted.',
  })
  submitRun(@Param('runId') runId: string, @CurrentUser() user: JwtPayload) {
    return this.service.submitRun(runId, user.sub, user.email);
  }

  @Get('submissions')
  @ApiOperation({ summary: 'List past statutory submissions' })
  listSubmissions(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.service.listSubmissions(page ?? 1, Math.min(limit ?? 20, 100));
  }

  @Get('submissions/:submissionId')
  @ApiOperation({ summary: 'Check a submission’s status with the provider' })
  getSubmissionStatus(@Param('submissionId') submissionId: string) {
    return this.service.getSubmissionStatus(submissionId);
  }
}
