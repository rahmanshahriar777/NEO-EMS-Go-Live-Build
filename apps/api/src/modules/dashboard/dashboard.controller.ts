import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('kpis')
  @ApiOperation({
    summary: 'Role-aware dashboard KPIs',
    description:
      'Headcount, today\'s attendance, pending approvals, leave balances and ' +
      'payroll cost. Scope (company/team/self) is resolved through the ' +
      'access-policy service; sensitive aggregates are null outside company scope.',
  })
  getKpis(@CurrentUser() user: JwtPayload) {
    return this.service.getKpis({
      sub: user.sub,
      employeeId: user.employeeId,
      roles: (user.roles ?? []) as string[],
    });
  }
}
