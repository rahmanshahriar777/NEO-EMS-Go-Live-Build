import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateRosterEntryDto {
  @ApiProperty({ description: 'Employee being rostered' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({
    description: 'Roster day (calendar date). Overtime day-totals key off startTime/endTime, not this field.',
    example: '2026-10-05',
  })
  @IsDateString()
  date: string;

  @ApiPropertyOptional({ description: 'Shift label, e.g. "Morning", "Night"', example: 'Morning' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  shiftName?: string;

  @ApiProperty({
    description: 'Shift start (ISO datetime). Must be before endTime.',
    example: '2026-10-05T08:00:00.000Z',
  })
  @IsDateString()
  startTime: string;

  @ApiProperty({
    description:
      'Shift end (ISO datetime). For overnight shifts set this on the following day.',
    example: '2026-10-05T16:00:00.000Z',
  })
  @IsDateString()
  endTime: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateRosterEntryDto extends PartialType(CreateRosterEntryDto) {}

export class RosterQueryDto {
  @ApiPropertyOptional({ description: 'Filter by employee (HR/admin; managers limited to their team)' })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Range start (ISO date)', example: '2026-10-01' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO date, inclusive)', example: '2026-10-31' })
  @IsDateString()
  @IsOptional()
  to?: string;

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
}
