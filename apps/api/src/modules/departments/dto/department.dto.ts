import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'ENG' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  code: string;

  @ApiPropertyOptional({ example: 'Software development department' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  headEmployeeId?: string;

  @ApiPropertyOptional({ description: 'Legal entity scope (Phase 3, item 1)' })
  @IsUUID()
  @IsOptional()
  entityId?: string;
}

export class UpdateDepartmentDto extends CreateDepartmentDto {}
