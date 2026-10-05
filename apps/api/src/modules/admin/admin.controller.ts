import { Controller, Post, Delete, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

/**
 * Go-live Phase 2 item 8 — admin account-recovery endpoints.
 *
 * Follows the auth/users convention: SUPER_ADMIN or HR_ADMIN only (global
 * RolesGuard reads the @Roles metadata). Every action is audit-logged in
 * AdminService with the acting admin's identity.
 *
 *   POST   /admin/users/:id/unlock    — clear lockedUntil/failedLoginAttempts
 *   DELETE /admin/users/:id/sessions  — revoke all refresh tokens (sign out everywhere)
 */
@ApiTags('Admin')
@Controller('admin')
@Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('users/:id/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlock a user account (clear lockout counters)' })
  async unlock(@Param('id') id: string, @CurrentUser() caller: JwtPayload) {
    const result = await this.adminService.unlockUser(id, {
      userId: caller.sub,
      email: caller.email,
    });
    return { success: true, data: result };
  }

  @Delete('users/:id/sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Terminate all sessions for a user (revoke every refresh token)' })
  async killSessions(@Param('id') id: string, @CurrentUser() caller: JwtPayload) {
    const result = await this.adminService.killSessions(id, {
      userId: caller.sub,
      email: caller.email,
    });
    return { success: true, data: result };
  }
}
