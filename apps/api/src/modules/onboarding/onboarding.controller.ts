import { Controller, Get, Post, Patch, Param, Body, Query, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OnboardingService, OnboardingViewer } from './onboarding.service';
import { CreateChecklistDto, CompleteTaskDto, AssignTaskDto } from './dto/onboarding.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
@ApiTags('Onboarding & Offboarding')
@ApiBearerAuth()
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  private toViewer(user: JwtPayload): OnboardingViewer {
    return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
  }

  @Post('checklists')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Start an onboarding/offboarding checklist (HR/admin)' })
  createChecklist(@Body() dto: CreateChecklistDto, @CurrentUser() user: JwtPayload) {
    return this.service.createChecklist(dto, this.toViewer(user));
  }

  @Get('checklists')
  @ApiOperation({ summary: 'List checklists (scoped: HR all, manager team+self, employee self)' })
  listChecklists(@CurrentUser() user: JwtPayload, @Query('employeeId') employeeId?: string) {
    if (!user.employeeId && !user.roles.includes(SystemRole.HR_ADMIN) && !user.roles.includes(SystemRole.SUPER_ADMIN)) {
      throw new ForbiddenException('Employee profile required');
    }
    return this.service.listChecklists(this.toViewer(user), employeeId);
  }

  @Get('checklists/:id')
  @ApiOperation({ summary: 'Get a checklist with its tasks (ownership-checked)' })
  getChecklist(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.getChecklist(id, this.toViewer(user));
  }

  @Patch('tasks/:id/assign')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Assign a task owner (HR/admin)' })
  assignTask(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.assignTask(id, dto, this.toViewer(user));
  }

  @Patch('tasks/:id/complete')
  @ApiOperation({ summary: 'Complete a task (owner, assignee, or HR)' })
  completeTask(
    @Param('id') id: string,
    @Body() dto: CompleteTaskDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.completeTask(id, dto, this.toViewer(user));
  }
}
