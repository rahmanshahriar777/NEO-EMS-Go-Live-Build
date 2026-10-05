import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OnboardingTaskTemplateDto {
  @ApiProperty({ example: 'Sign employment contract' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 'HR', description: 'Owner role: HR | MANAGER | EMPLOYEE | IT' })
  @IsString()
  @IsOptional()
  ownerRole?: string;

  @ApiPropertyOptional({ example: 1, description: 'Due N days after the start/exit date' })
  @IsOptional()
  dueDayOffset?: number;
}

export class CreateChecklistDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ enum: ['ONBOARDING', 'OFFBOARDING'] })
  @IsEnum(['ONBOARDING', 'OFFBOARDING'] as any)
  kind: 'ONBOARDING' | 'OFFBOARDING';

  @ApiPropertyOptional({ example: '2026-11-01', description: 'Start date (onboarding) or last day (offboarding), YYYY-MM-DD' })
  @IsString()
  @IsOptional()
  referenceDate?: string;

  @ApiPropertyOptional({ type: [OnboardingTaskTemplateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingTaskTemplateDto)
  @IsOptional()
  tasks?: OnboardingTaskTemplateDto[];
}

export class CompleteTaskDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Linked document id (document collection step)' })
  @IsUUID()
  @IsOptional()
  documentId?: string;
}

export class AssignTaskDto {
  @ApiProperty({ description: 'Owner USER id' })
  @IsUUID()
  @IsNotEmpty()
  ownerUserId: string;
}
