import { Controller, Get, Delete, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MfaService } from './mfa.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';

/**
 * Active-sessions endpoints (Phase 2, item 8 — "active-sessions page backend").
 *
 * Route contract (web UI): GET /auth/sessions, DELETE /auth/sessions/:id.
 * Backed by the refresh_tokens table (one row per token family).
 * Lives in MfaModule (it already owns TokenService via AuthModule) to avoid
 * an AuthModule ↔ MfaModule circular dependency.
 */
@ApiTags('Sessions')
@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly mfaService: MfaService) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions (refresh-token families)' })
  async list(@CurrentUser() user: JwtPayload) {
    const sessions = await this.mfaService.listSessions(user.sub);
    return { success: true, data: sessions };
  }

  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session (sign out that device)' })
  async revokeOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.mfaService.revokeSession(user.sub, id);
    return { success: true, message: 'Session revoked' };
  }
}
