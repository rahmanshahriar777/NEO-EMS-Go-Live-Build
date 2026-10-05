import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RosteringService } from './rostering.service';
import {
  CreateRosterEntryDto,
  RosterQueryDto,
  UpdateRosterEntryDto,
} from './dto/rostering.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload, SystemRole } from '@ems/shared';

// @Permissions() intentionally not attached — see the note in
// gdpr.controller.ts (role -> permission grants are not seeded yet).
@ApiTags('Rostering')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('rostering')
export class RosteringController {
  constructor(private readonly service: RosteringService) {}

  @Get()
  @ApiOperation({
    summary:
      'List roster entries (scoped: HR all, manager team+self, others self). Each entry includes hoursWorked, overtimeMinutes and overtime.',
  })
  findAll(@Query() query: RosterQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.findAllScoped(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a roster entry with overtime computation (ownership-scoped)' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOneScoped(id, user);
  }

  @Post()
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a roster entry (manager/HR/admin only)' })
  create(@Body() dto: CreateRosterEntryDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update a roster entry (manager/HR/admin only)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRosterEntryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete a roster entry (manager/HR/admin only)' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user);
  }
}
