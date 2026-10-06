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
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): JwtAuthGuard + RolesGuard are global; per-controller duplication removed.
@ApiTags('Departments')
@ApiBearerAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly service: DepartmentsService) {}

  @Get()
  @ApiOperation({ summary: 'List all active departments (entityId filter, allowlisted sort)' })
  findAll(
    @Query('entityId') entityId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.service.findAll({ entityId, sortBy, sortOrder });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get department details with hierarchy and staff count' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Permissions('DEPARTMENT:CREATE')
  @ApiOperation({ summary: 'Create a new department' })
  create(@Body() dto: CreateDepartmentDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub, user.email);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Permissions('DEPARTMENT:UPDATE')
  @ApiOperation({ summary: 'Update an existing department' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.sub, user.email);
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Permissions('DEPARTMENT:DELETE')
  @ApiOperation({ summary: 'Soft delete a department' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.sub, user.email);
  }
}
