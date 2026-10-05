import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateUserDto {
  @ApiProperty({ required: false, description: 'Deactivate/reactivate the account' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, description: 'Mark the email verified' })
  @IsOptional()
  @IsBoolean()
  emailVerified?: boolean;

  @ApiProperty({
    required: false,
    example: ['HR_ADMIN'],
    description: 'Replace role assignments (SUPER_ADMIN only). Values must be valid SystemRole names.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];
}

export class ListUsersQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  page?: number = 1;

  @ApiProperty({ required: false, default: 50 })
  @IsOptional()
  limit?: number = 50;

  @ApiProperty({ required: false, description: 'Filter by email substring' })
  @IsOptional()
  @IsString()
  search?: string;
}
