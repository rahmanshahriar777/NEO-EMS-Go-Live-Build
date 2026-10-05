import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { MfaService } from './mfa.service';
import {
  MfaSetupVerifyDto,
  MfaChallengeDto,
  MfaDisableDto,
} from '../auth/dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';
import { setAuthCookies } from '../../common/cookies/auth-cookies';

/**
 * Phase 2, item 8 — TOTP MFA endpoints.
 *
 * Route contract (web UI):
 *   POST /mfa/totp/setup    — start enrollment (secret + otpauth:// URI)
 *   POST /mfa/totp/verify   — confirm enrollment (returns recovery codes once)
 *   POST /mfa/totp/disable  — disable (requires current password)
 *   GET  /mfa/status        — enrollment state for the current user
 *   POST /mfa/challenge     — complete an MFA login (public, challenge token)
 *
 * Session management lives under /auth/sessions (SessionsController).
 */
@ApiTags('Multi-Factor Authentication')
@Controller('mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly configService: ConfigService,
  ) {}

  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start MFA enrollment: returns the TOTP secret + otpauth:// URI for the QR code' })
  async setup(@CurrentUser() user: JwtPayload) {
    const result = await this.mfaService.setupTotp(user.sub, user.email);
    return { success: true, data: result };
  }

  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm enrollment with a TOTP code; returns one-time recovery codes' })
  async verify(@CurrentUser() user: JwtPayload, @Body() dto: MfaSetupVerifyDto) {
    const result = await this.mfaService.verifySetup(user.sub, dto.token);
    return {
      success: true,
      message: 'MFA enabled. Store these recovery codes securely — they are shown only once.',
      data: result,
    };
  }

  @Post('totp/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable MFA (requires current password)' })
  async disable(@CurrentUser() user: JwtPayload, @Body() dto: MfaDisableDto) {
    await this.mfaService.disableMfa(user.sub, dto.password);
    return { success: true, message: 'MFA disabled' };
  }

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'MFA enrollment status for the current user' })
  async status(@CurrentUser() user: JwtPayload) {
    const status = await this.mfaService.getStatus(user.sub);
    return { success: true, data: status };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete an MFA login with a TOTP code or recovery code' })
  async challenge(
    @Body() dto: MfaChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    const result = await this.mfaService.completeChallenge(dto.challengeToken, dto.code, ip);
    // Item 8: session tokens travel in httpOnly cookies only, never the body.
    setAuthCookies(res, result.tokens, this.configService);
    return {
      success: true,
      message: 'Logged in successfully',
      data: { user: result.user },
    };
  }
}
