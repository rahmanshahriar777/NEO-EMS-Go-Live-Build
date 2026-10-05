import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RecruitmentService, RecruitmentViewer } from './recruitment.service';
import {
  CreateVacancyDto,
  CreateCandidateDto,
  UpdateCandidateStageDto,
  CreateOfferDto,
} from './dto/recruitment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): guards are global; per-controller @UseGuards duplication removed.
@ApiTags('Recruitment')
@ApiBearerAuth()
@Controller('recruitment')
export class RecruitmentController {
  constructor(private readonly service: RecruitmentService) {}

  private toViewer(user: JwtPayload): RecruitmentViewer {
    return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
  }

  @Get('vacancies')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @ApiOperation({ summary: 'List vacancies' })
  listVacancies(@Query('status') status?: string) {
    return this.service.listVacancies(status);
  }

  @Post('vacancies')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a vacancy (HR/admin)' })
  createVacancy(@Body() dto: CreateVacancyDto, @CurrentUser() user: JwtPayload) {
    return this.service.createVacancy(dto, this.toViewer(user));
  }

  @Post('candidates')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Add a candidate to a vacancy (HR/admin)' })
  addCandidate(@Body() dto: CreateCandidateDto, @CurrentUser() user: JwtPayload) {
    return this.service.addCandidate(dto, this.toViewer(user));
  }

  @Get('vacancies/:id/candidates')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'List candidates for a vacancy (HR/admin)' })
  listCandidates(
    @Param('id') id: string,
    @Query('stage') stage: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.listCandidates(id, stage, this.toViewer(user));
  }

  @Patch('candidates/:id/stage')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Move a candidate through the pipeline (HR/admin)' })
  updateStage(
    @Param('id') id: string,
    @Body() dto: UpdateCandidateStageDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateCandidateStage(id, dto, this.toViewer(user));
  }

  @Post('candidates/:id/offers')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create an offer for a candidate (HR/admin)' })
  createOffer(
    @Param('id') id: string,
    @Body() dto: CreateOfferDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.createOffer(id, dto, this.toViewer(user));
  }

  @Post('offers/:id/accept')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({
    summary: 'Accept an offer — candidate becomes HIRED and an employee record is auto-created',
  })
  acceptOffer(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.acceptOffer(id, this.toViewer(user));
  }
}
