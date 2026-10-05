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
import { EmployeesService, toEmployeeViewer } from './employees.service';
import { CreateEmployeeDto, UpdateEmployeeDto, EmployeeQueryDto, UpdateAvatarDto } from './dto/employee.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

// NOTE (B1): authentication/authorization guards are global (JwtAuthGuard →
// RolesGuard → PermissionsGuard as APP_GUARD); per-controller @UseGuards
// duplication was removed. @Roles metadata below is still honoured.

@ApiTags('Employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly service: EmployeesService) {}

  @Get()
  @ApiOperation({ summary: 'List employees (scoped by role: HR all, manager team+self, others self)' })
  findAll(@Query() query: EmployeeQueryDto, @CurrentUser() user: JwtPayload) {
    return this.service.findAllScoped(query, toEmployeeViewer(user));
  }

  @Get('me')
  @ApiOperation({ summary: 'Get profile of current authenticated employee' })
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.service.getMyProfile(user.sub, user.employeeId);
  }

  @Patch('me/avatar')
  @ApiOperation({ summary: 'Update or remove personal profile picture for authenticated employee' })
  updateMyAvatar(
    @Body() dto: UpdateAvatarDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateMyAvatar(user.sub, user.employeeId, dto.avatarUrl, user.email);
  }

  @Get('me/avatar-url')
  @ApiOperation({ summary: 'Resolve current employee avatar to a client-usable URL' })
  getMyAvatarUrl(@CurrentUser() user: JwtPayload) {
    return this.service.getMyAvatarUrl(user.sub, user.employeeId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get employee profile (ownership-scoped; compensation restricted to HR/admin)' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOneScoped(id, toEmployeeViewer(user));
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Create a new employee profile' })
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub, user.email);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER)
  @ApiOperation({
    summary: 'Update an employee profile (A1: managers edit DIRECT REPORTS ONLY, allowlisted fields)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateScoped(id, dto, toEmployeeViewer(user));
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiOperation({ summary: 'Soft delete and deactivate employee' })
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, user.sub, user.email);
  }

  @Get(':id/audit-logs')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Get mutation audit history for an employee' })
  getAuditLogs(@Param('id') id: string) {
    return this.service.getAuditLogs(id);
  }
}
