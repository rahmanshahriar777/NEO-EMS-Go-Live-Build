import { Controller, Get, Post, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get('ical-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get personal leave calendar feed token and URL for current user',
  })
  getMyIcalToken(@CurrentUser() user: JwtPayload) {
    const token = this.service.buildFeedToken(user.sub);
    return { token, path: `/integrations/ical/${token}` };
  }

  /**
   * Leave calendar iCal feed. Public route by design (calendar apps cannot do
   * OAuth) — authentication is the HMAC feed token itself. The token reveals
   * only the holder's own approved leave + company holidays.
   */
  @Public()
  @Get('ical/:token')
  @ApiOperation({
    summary: 'Personal leave calendar as iCal (token-authenticated feed)',
    description:
      'Subscribe in any calendar app. The token is HMAC-bound to the user; ' +
      'rotating ICAL_FEED_SECRET invalidates all feeds.',
  })
  async getIcalFeed(@Param('token') token: string, @Res() res: Response) {
    const ics = await this.service.buildLeaveCalendar(token);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leave-calendar.ics"');
    res.send(ics);
  }

  @Get('accounting/export')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Accounting journal CSV export for a payroll run',
    description:
      'Double-entry lines per payslip (DR wages / CR deductions payable / ' +
      'CR net pay payable). Account codes via ACCOUNTING_*_ACCOUNT env.',
  })
  async accountingExport(@Query('payrollRunId') payrollRunId: string, @Res() res: Response) {
    const { csv, filename } = await this.service.accountingExport(payrollRunId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Post('alert')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Dispatch an alert notification to configured Slack and Microsoft Teams webhooks',
  })
  async sendAlert(
    @Body() body: { title: string; message: string; linkUrl?: string },
  ) {
    return this.service.dispatchAlert(body);
  }

  @Post('hris/import')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Synchronise bulk employee records from an external HRIS system',
  })
  async importHris(
    @Body()
    body: {
      employees: Array<{
        firstName: string;
        lastName: string;
        email: string;
        departmentCode?: string;
        designationTitle?: string;
        phone?: string;
      }>;
    },
  ) {
    return this.service.importHrisEmployees(body.employees || []);
  }
}
