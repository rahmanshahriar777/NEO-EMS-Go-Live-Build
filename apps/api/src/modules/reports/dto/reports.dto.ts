import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AdHocReportFiltersDto {
  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by department ID' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Filter by designation ID' })
  @IsOptional()
  @IsString()
  designationId?: string;

  @ApiPropertyOptional({ description: 'Filter by leave type ID' })
  @IsOptional()
  @IsString()
  leaveTypeId?: string;

  @ApiPropertyOptional({ description: 'Filter by date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiPropertyOptional({ description: 'Filter by payroll year' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  year?: number;

  @ApiPropertyOptional({ description: 'Filter by payroll month (1-12)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  month?: number;
}

export class AdHocReportDto {
  @ApiProperty({
    enum: ['employees', 'leaves', 'attendance', 'payroll'],
    description: 'Target core entity dataset',
  })
  @IsIn(['employees', 'leaves', 'attendance', 'payroll'])
  entity!: 'employees' | 'leaves' | 'attendance' | 'payroll';

  @ApiPropertyOptional({
    description: 'Allowlisted entity filter criteria',
    type: AdHocReportFiltersDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AdHocReportFiltersDto)
  filters?: AdHocReportFiltersDto;

  @ApiPropertyOptional({
    description: 'Maximum record limit (1-1000)',
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  @Type(() => Number)
  limit?: number;
}
