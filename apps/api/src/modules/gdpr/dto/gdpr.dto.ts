import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ErasureStatus } from '@ems/database';

/** Review decision for an erasure request (distinct from ErasureStatus). */
export enum ErasureDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class CreateErasureRequestDto {
  @ApiPropertyOptional({
    description: 'Why the employee is requesting erasure (optional free text)',
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reason?: string;
}

export class ReviewErasureRequestDto {
  @ApiProperty({
    enum: ErasureDecision,
    description: 'APPROVE runs anonymisation; REJECT closes the request with a reason',
  })
  @IsEnum(ErasureDecision)
  decision: ErasureDecision;

  @ApiPropertyOptional({
    description: 'Required when decision is REJECT; stored on the request for the audit trail',
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reason?: string;
}

export class ErasureRequestQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ErasureStatus, description: 'Filter by request status' })
  @IsEnum(ErasureStatus)
  @IsOptional()
  status?: ErasureStatus;
}

/** Retention purge trigger. Real deletes require BOTH dryRun:false AND counsel sign-off. */
export class PurgeRetentionDto {
  @ApiPropertyOptional({
    description:
      'Set false to actually delete. Ignored (forced dry-run) until counsel ' +
      'sign-off is recorded via GDPR_RETENTION_SIGNED_OFF=true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean = true;
}
