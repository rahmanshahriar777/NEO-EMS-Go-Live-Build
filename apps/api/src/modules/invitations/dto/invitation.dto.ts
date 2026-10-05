import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateInvitationDto {
  @ApiProperty({ example: 'new.hire@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: 'EMPLOYEE',
    description: 'SystemRole to grant on accept (e.g. EMPLOYEE, MANAGER, HR_ADMIN)',
  })
  @IsString()
  @IsNotEmpty()
  role: string;

  @ApiProperty({
    required: false,
    description: 'Existing employee record to link the new user to. Omit to scaffold a new employee profile.',
  })
  @IsOptional()
  @IsString()
  employeeId?: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'Invitation token from the email link' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'BrandNewPassword789!' })
  @IsString()
  @MinLength(12)
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
