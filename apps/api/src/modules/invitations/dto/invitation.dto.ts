import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateInvitationDto {
  @ApiProperty({ example: 'new.hire@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    required: false,
    example: 'EMPLOYEE',
    description: 'SystemRole to grant on accept (e.g. EMPLOYEE, MANAGER, HR_ADMIN)',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({
    required: false,
    example: ['EMPLOYEE'],
    description: 'Alternative list of roles (accepts array for compatibility)',
  })
  @IsOptional()
  @IsArray()
  roleIds?: string[];

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
