import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PasswordResetService } from './password-reset.service';
import { RequestPasswordResetDto, ConfirmPasswordResetDto } from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Password-reset endpoints (item 4). Kept as a separate controller so the
 * existing AuthController stays untouched apart from the item-8 body change.
 */
@ApiTags('Authentication')
@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password-reset email (always returns 200)' })
  @ApiResponse({ status: 200, description: 'Generic response — reveals nothing about account existence' })
  async request(@Body() dto: RequestPasswordResetDto) {
    await this.passwordResetService.requestPasswordReset(dto.email);
    return {
      success: true,
      message: 'If an account exists for this email, a password-reset link has been sent.',
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume a password-reset token and set a new password' })
  async confirm(@Body() dto: ConfirmPasswordResetDto) {
    await this.passwordResetService.confirmPasswordReset(dto.token, dto.newPassword);
    return {
      success: true,
      message: 'Password has been reset. Please log in with your new password.',
    };
  }
}
