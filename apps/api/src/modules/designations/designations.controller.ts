import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DesignationsService } from './designations.service';
import { CreateDesignationDto, UpdateDesignationDto } from './dto/designation.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): JwtAuthGuard + RolesGuard are global; per-controller duplication removed.
@ApiTags('Designations')
@ApiBearerAuth()
@Controller('designations')
export class DesignationsController {
  constructor(private readonly service: DesignationsService) {}

  @Get()
  @ApiOperation({ summary: 'List designations, optionally filtered by department/entity' })
  findAll(
    @Query('departmentId') departmentId?: string,
    @Query('entityId') entityId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.service.findAll({ departmentId, entityId, sortBy, sortOrder });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get designation details' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a new designation' })
  create(@Body() dto: CreateDesignationDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub, user.email);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Update an existing designation' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDesignationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.sub, user.email);
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Soft delete a designation' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.sub, user.email);
  }
}
