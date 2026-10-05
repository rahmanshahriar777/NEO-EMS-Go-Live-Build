import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PerformanceService, toPerformanceViewer } from './performance.service';
import {
  CreateReviewCycleDto,
  CreatePerformanceReviewDto,
  SubmitSelfReviewDto,
  SubmitManagerReviewDto,
  CreateGoalDto,
  UpdateGoalDto,
  SubmitFeedbackDto,
  CreateReviewFormDto,
} from './dto/performance.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
@ApiTags('Performance & Goals')
@ApiBearerAuth()
@Controller()
export class PerformanceController {
  constructor(private readonly service: PerformanceService) {}

  @Get('performance/cycles')
  @ApiOperation({ summary: 'List all review cycles' })
  getCycles() {
    return this.service.getCycles();
  }

  @Post('performance/cycles')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a new performance review cycle' })
  createCycle(@Body() dto: CreateReviewCycleDto, @CurrentUser() user: JwtPayload) {
    return this.service.createCycle(dto, user.sub, user.email);
  }

  @Get('performance/review-forms')
  @ApiOperation({ summary: 'List review form templates (HR-managed, or the built-in default)' })
  getReviewForms() {
    return this.service.getReviewForms();
  }

  @Post('performance/review-forms')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a review form template (HR/admin)' })
  createReviewForm(@Body() dto: CreateReviewFormDto, @CurrentUser() user: JwtPayload) {
    return this.service.createReviewForm(dto, user.sub, user.email);
  }

  @Get('performance/review-forms/:id')
  @ApiOperation({ summary: 'Get a review form template' })
  getReviewForm(@Param('id') id: string) {
    return this.service.getReviewForm(id);
  }

  @Get('performance/reviews')
  @ApiOperation({
    summary: 'List performance reviews (A6: scoped; empty when no linked employee)',
  })
  getReviews(
    @CurrentUser() user: JwtPayload,
    @Query('employeeId') employeeId?: string,
    @Query('cycleId') cycleId?: string,
  ) {
    return this.service.getReviews(toPerformanceViewer(user), employeeId, cycleId);
  }

  @Post('performance/reviews')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @ApiOperation({ summary: 'Initiate a performance review (non-HR: direct reports only)' })
  createReview(@Body() dto: CreatePerformanceReviewDto, @CurrentUser() user: JwtPayload) {
    return this.service.createReview(dto, toPerformanceViewer(user));
  }

  @Patch('performance/reviews/:id/self-review')
  @ApiOperation({ summary: 'Submit employee self evaluation (locked once completed)' })
  submitSelfReview(
    @Param('id') id: string,
    @Body() dto: SubmitSelfReviewDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.employeeId) throw new ForbiddenException('Employee profile required');
    return this.service.submitSelfReview(id, user.employeeId, dto);
  }

  @Patch('performance/reviews/:id/manager-review')
  @Roles(SystemRole.MANAGER, SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Submit manager evaluation (A3: assigned reviewer only; completed reviews locked)',
  })
  submitManagerReview(
    @Param('id') id: string,
    @Body() dto: SubmitManagerReviewDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.employeeId) throw new ForbiddenException('Manager employee profile required');
    return this.service.submitManagerReview(
      id,
      user.employeeId,
      dto,
      toPerformanceViewer(user),
    );
  }

  @Get('goals')
  @ApiOperation({ summary: 'List goals (A4: scoped to self/team/HR; foreign employeeId → 409)' })
  getGoals(@CurrentUser() user: JwtPayload, @Query('employeeId') employeeId?: string) {
    return this.service.getGoalsScoped(toPerformanceViewer(user), employeeId);
  }

  @Post('goals')
  @ApiOperation({ summary: 'Create a personal or team goal (A4: scoped)' })
  createGoal(@Body() dto: CreateGoalDto, @CurrentUser() user: JwtPayload) {
    return this.service.createGoalScoped(toPerformanceViewer(user), dto);
  }

  @Patch('goals/:id')
  @ApiOperation({ summary: 'Update goal progress and status' })
  updateGoal(
    @Param('id') id: string,
    @Body() dto: UpdateGoalDto,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.employeeId) throw new ForbiddenException('Employee profile required');
    return this.service.updateGoal(id, user.employeeId, dto, toPerformanceViewer(user));
  }

  @Post('feedback')
  @ApiOperation({ summary: 'Submit 360 peer or manager feedback' })
  submitFeedback(@Body() dto: SubmitFeedbackDto, @CurrentUser() user: JwtPayload) {
    if (!user.employeeId) throw new ForbiddenException('Employee profile required');
    return this.service.submitFeedback(user.employeeId, dto);
  }

  @Get('feedback')
  @ApiOperation({ summary: 'View feedback received by current employee' })
  getFeedback(@CurrentUser() user: JwtPayload) {
    if (!user.employeeId) throw new ForbiddenException('Employee profile required');
    return this.service.getFeedback(user.employeeId);
  }
}
