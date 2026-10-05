import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CreateDesignationDto {
  @ApiProperty({ example: 'Senior Software Engineer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({ example: 'SR_ENG' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;

  @ApiPropertyOptional({ example: 'Technical lead for features' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 4 })
  @IsInt()
  @Min(1)
  @Max(15)
  @IsOptional()
  level?: number;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;
}

export class UpdateDesignationDto extends CreateDesignationDto {}
