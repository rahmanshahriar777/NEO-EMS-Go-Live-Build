import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CalendarQueryDto {
  @ApiPropertyOptional({
    description: 'Range start (ISO date). Defaults to today.',
    example: '2026-10-01',
  })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({
    description: 'Range end (ISO date, inclusive). Defaults to from + 30 days.',
    example: '2026-10-31',
  })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class HolidaysQueryDto {
  @ApiPropertyOptional({
    description: 'Calendar year. Defaults to the current year.',
    example: 2026,
  })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  @IsOptional()
  year?: number;
}
