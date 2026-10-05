import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RegisterDto,
  RefreshTokenDto,
  ChangePasswordDto,
  VerifyEmailDto,
  ResendVerificationDto,
} from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { SetsAuthCookies } from '../../common/decorators/sets-auth-cookies.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '@ems/shared';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { REFRESH_TOKEN_COOKIE, getCookieValue } from './jwt.strategy';
import { setAuthCookies, clearAuthCookies } from '../../common/cookies/auth-cookies';

/**
 * Item 8 — cookie-only token contract: login/refresh/mfa-challenge set the
 * httpOnly `ems_at` / `ems_rt` cookies (+ the double-submit `csrf` cookie)
 * and NEVER return tokens in the JSON body. Body payloads carry only the
 * user profile and status messages.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @SetsAuthCookies()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiResponse({ status: 200, description: 'Authentication successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials (generic — account state is never revealed)' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ip, userAgent);

    // MFA-enrolled user: password passed, second factor still required.
    if ('mfaRequired' in result) {
      return {
        success: true,
        mfaRequired: true,
        challengeToken: result.challengeToken,
        message: 'Second factor required. Submit your authenticator code to complete login.',
      };
    }

    setAuthCookies(res, result.tokens, this.configService);
    return {
      success: true,
      message: 'Logged in successfully',
      data: { user: result.user },
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user account (email verification required before login; disabled unless ALLOW_PUBLIC_REGISTRATION=true)' })
  @ApiResponse({ status: 201, description: 'Account created — verify email before logging in' })
  @ApiResponse({ status: 403, description: 'Public registration is disabled (invite-only)' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const ip = req.ip || req.socket.remoteAddress;
    const result = await this.authService.register(dto, ip);
    return {
      success: true,
      message: result.message,
      data: { user: result.user },
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address with the token sent at registration' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
    return {
      success: true,
      message: 'Email verified successfully. You can now log in.',
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the email verification token' })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.authService.resendVerification(dto.email);
    return {
      success: true,
      message: 'If an unverified account exists for this email, a new verification token was sent.',
    };
  }

  @Public()
  @SetsAuthCookies()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token and issue new access token (cookies only)' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip || req.socket.remoteAddress;
    // The client may send the refresh token in the body or rely on the
    // ems_rt httpOnly cookie; body takes precedence.
    // (Parsed manually from the Cookie header — no cookie-parser dependency.)
    const presented = dto.refreshToken || getCookieValue(req, REFRESH_TOKEN_COOKIE);
    if (!presented) {
      throw new BadRequestException('Refresh token is required');
    }
    const tokens = await this.authService.refreshToken(presented, ip);
    setAuthCookies(res, tokens, this.configService);
    return {
      success: true,
      message: 'Token refreshed successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke active session' })
  async logout(
    @Body() dto: Partial<RefreshTokenDto>,
    @CurrentUser() user?: JwtPayload,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const refreshToken = dto?.refreshToken;
    if (user?.sub || refreshToken) {
      await this.authService.logout(refreshToken, user?.sub);
    }
    if (res) {
      clearAuthCookies(res, this.configService);
    }
    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile and roles' })
  async getMe(@CurrentUser('sub') userId: string) {
    const user = await this.authService.getMe(userId);
    return {
      success: true,
      data: user,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change current user password' })
  async changePassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.authService.changePassword(userId, dto);
    return {
      success: true,
      message: 'Password changed successfully. Please log in again.',
    };
  }
}
