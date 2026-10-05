import { Controller, Get, Patch, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto, ListUsersQueryDto } from './dto/users.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

/**
 * Admin user management (web UI: GET /auth/users, PATCH /auth/users/:id).
 * HR_ADMIN and SUPER_ADMIN may list and toggle account flags; role
 * assignment changes require SUPER_ADMIN (enforced in UsersService).
 */
@ApiTags('User Management')
@Controller('auth/users')
@Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List users (paginated, safe projection — no password hashes)' })
  async list(@Query() query: ListUsersQueryDto) {
    const result = await this.usersService.listUsers(query.page, query.limit, query.search);
    return { success: true, ...result };
  }

  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a user: isActive / emailVerified flags, role assignments (SUPER_ADMIN only)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    const user = await this.usersService.updateUser(caller.sub, caller.roles, id, dto);
    return { success: true, data: user };
  }
}
