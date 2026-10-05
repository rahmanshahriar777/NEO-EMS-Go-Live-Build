import { Controller, Get, Post, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto, AcceptInvitationDto } from './dto/invitation.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SystemRole, JwtPayload } from '@ems/shared';

@ApiTags('Invitations')
@Controller('auth/invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Post()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'HR creates an invitation (emailed token link)' })
  async create(@Body() dto: CreateInvitationDto, @CurrentUser() user: JwtPayload) {
    const invitation = await this.invitationsService.createInvitation(user.sub, dto);
    return {
      success: true,
      message: `Invitation sent to ${invitation.email}`,
      data: invitation,
    };
  }

  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List invitations (newest first)' })
  async list() {
    const invitations = await this.invitationsService.listInvitations();
    // Never expose token hashes to clients.
    const safe = invitations.map(({ tokenHash, ...rest }) => rest);
    return { success: true, data: safe };
  }

  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Delete(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(@Param('id') id: string) {
    await this.invitationsService.revokeInvitation(id);
    return { success: true, message: 'Invitation revoked' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Accept an invitation: set password and activate the account' })
  async accept(@Body() dto: AcceptInvitationDto) {
    const result = await this.invitationsService.acceptInvitation(dto);
    return {
      success: true,
      message: 'Invitation accepted. You can now log in.',
      data: result,
    };
  }
}
