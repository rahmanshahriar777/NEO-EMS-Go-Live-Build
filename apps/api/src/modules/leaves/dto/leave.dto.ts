import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LeaveStatus, LeaveTypeEnum } from '@ems/shared';

export class CreateLeaveRequestDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  leaveTypeId: string;

  @ApiProperty({ example: '2026-10-10' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate must be YYYY-MM-DD' })
  startDate: string;

  @ApiProperty({ example: '2026-10-12' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate must be YYYY-MM-DD' })
  endDate: string;

  @ApiProperty({ example: 'Family vacation and personal appointment' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: 'Half-day leave (0.5 day). Requires startDate == endDate on a working day.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  halfDay?: boolean;

  @ApiPropertyOptional({ enum: ['AM', 'PM'], description: 'Which half of the day (half-day leave only)' })
  @IsString()
  @IsOptional()
  halfDayPeriod?: string;
}

export class ApproveLeaveDto {
  @ApiProperty({ enum: [LeaveStatus.APPROVED, LeaveStatus.REJECTED] })
  @IsEnum([LeaveStatus.APPROVED, LeaveStatus.REJECTED])
  status: LeaveStatus.APPROVED | LeaveStatus.REJECTED;

  @ApiPropertyOptional({ example: 'Approved. Enjoy your time off.' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  remarks?: string;
}

export class CreateLeaveTypeDto {
  @ApiProperty({ example: 'Maternity Leave' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'MATERNITY' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;

  @ApiProperty({ enum: LeaveTypeEnum, default: LeaveTypeEnum.ANNUAL })
  @IsEnum(LeaveTypeEnum)
  type: LeaveTypeEnum;

  @ApiProperty({ example: 90 })
  @IsInt()
  @Min(1)
  @Max(365)
  defaultDaysPerYear: number;

  @ApiProperty({ default: true })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean = true;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateHolidayDto {
  @ApiProperty({ example: 'New Year Day' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: '2026-01-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean = true;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}

/**
 * Phase 2, item 6 — leave policy v2. Schema need (worker 4): new model
 * LeavePolicy (see LeavesService header comment).
 */
export class CreateLeavePolicyDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  leaveTypeId: string;

  @ApiPropertyOptional({ example: 1.5, description: 'Days accrued per month' })
  @IsNumber()
  @Min(0)
  @Max(31)
  @IsOptional()
  accrualPerMonth?: number;

  @ApiPropertyOptional({ example: 5, description: 'Max unused days carried into next year' })
  @IsNumber()
  @Min(0)
  @Max(365)
  @IsOptional()
  carryOverCap?: number;

  @ApiPropertyOptional({
    example: [1, 2, 3, 4, 5],
    description: 'Working-week pattern (0=Sun … 6=Sat)',
  })
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @IsOptional()
  workingDays?: number[];

  @ApiPropertyOptional({ example: 10, description: 'Max consecutive days per request' })
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  maxConsecutiveDays?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  requiresHrApproval?: boolean;
}
