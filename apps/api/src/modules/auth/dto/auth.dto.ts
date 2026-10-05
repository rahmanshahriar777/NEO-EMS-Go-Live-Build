import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, Matches } from 'class-validator';

/**
 * Password policy (Phase 1 hardening): 12-character minimum on every
 * password SET (register, invitation accept, change, reset). LoginDto keeps
 * the old 8-char floor so legacy accounts can still authenticate and be
 * transparently re-hashed to Argon2id on success.
 */
const PASSWORD_MIN_LENGTH = 12;

export class LoginDto {
  @ApiProperty({ example: 'superadmin@ems.local' })
  @IsEmail({}, { message: 'Must be a valid email address' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Str0ng!Example9' })
  @IsString()
  @MinLength(8)
  @IsNotEmpty()
  password: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'new.employee@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Str0ng!Example9' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @IsNotEmpty()
  password: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Smith' })
  @IsString()
  @IsNotEmpty()
  lastName: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'The long-lived refresh token. Optional when the ems_rt httpOnly cookie is sent.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refreshToken?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'Str0ng!Example9' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ example: 'NewStrongPassword456!' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @IsNotEmpty()
  newPassword: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Email verification token sent to the user' })
  @IsString()
  @IsNotEmpty()
  token: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'new.employee@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class RequestPasswordResetDto {
  @ApiProperty({ example: 'jane.smith@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ConfirmPasswordResetDto {
  @ApiProperty({ description: 'Password-reset token from the email link' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'BrandNewPassword789!' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @IsNotEmpty()
  newPassword: string;
}

export class MfaSetupVerifyDto {
  @ApiProperty({ description: '6-digit TOTP code from the authenticator app' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP code must be 6 digits' })
  token: string;
}

export class MfaChallengeDto {
  @ApiProperty({ description: 'Short-lived MFA challenge token from the login response' })
  @IsString()
  @IsNotEmpty()
  challengeToken: string;

  @ApiProperty({
    description: '6-digit TOTP code OR an unused recovery code',
    example: '123456',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}

export class MfaDisableDto {
  @ApiProperty({ description: 'Current password (confirms the disabling user)' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
