import { Controller, Get, Post, Patch, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { SystemRole } from '@ems/shared';

/**
 * Role & permission management (web UI role editor).
 * SUPER_ADMIN only — role grants are the keys to the kingdom.
 * NOTE: @Get('permissions') is declared before @Get(':id') so the literal
 * path is not swallowed by the parameter route.
 */
@ApiTags('Roles')
@Controller('roles')
@Roles(SystemRole.SUPER_ADMIN)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('permissions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all permissions in SUBJECT:ACTION format (role-editor source)' })
  async listPermissions() {
    const permissions = await this.rolesService.listPermissions();
    return { success: true, data: permissions };
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List roles with their permission grants' })
  async list() {
    const roles = await this.rolesService.listRoles();
    return { success: true, data: roles };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a role with optional permission grants' })
  async create(@Body() dto: CreateRoleDto) {
    const role = await this.rolesService.createRole(dto);
    return { success: true, data: role };
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a role: description and/or full permission grant set' })
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    const role = await this.rolesService.updateRole(id, dto);
    return { success: true, data: role };
  }

  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a custom role (system roles are protected)' })
  async remove(@Param('id') id: string) {
    await this.rolesService.deleteRole(id);
    return { success: true, message: 'Role deleted' };
  }
}
