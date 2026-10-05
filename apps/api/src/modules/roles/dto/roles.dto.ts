import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'PAYROLL_MANAGER', description: 'Unique role name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, example: 'Manages payroll runs and approvals' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    example: ['PAYROLL:READ', 'PAYROLL:APPROVE'],
    description: 'Permissions to grant, in SUBJECT:ACTION format',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateRoleDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    description: 'Replace the full permission grant set, in SUBJECT:ACTION format',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}
