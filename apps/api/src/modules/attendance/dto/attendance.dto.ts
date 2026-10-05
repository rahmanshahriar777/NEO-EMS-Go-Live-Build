import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AttendanceStatus } from '@ems/shared';

/**
 * Validates coordinate-looking location strings ("lat,lng").
 *
 * The location field is a free string (e.g. "Office - Floor 4"); this
 * validator only engages when the value LOOKS like coordinates, and then
 * enforces valid ranges: lat ∈ [-90, 90], lng ∈ [-180, 180]. Anything else
 * passes through untouched.
 */
@ValidatorConstraint({ name: 'CoordinatesOrFreeText', async: false })
class CoordinatesOrFreeText implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return true; // not coordinate-shaped → free text, allowed
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return (
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} looks like coordinates but is out of range (lat -90..90, lng -180..180)`;
  }
}

export class ClockInDto {
  @ApiPropertyOptional({ description: 'Optional target employee ID for admin override' })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional({ example: 'Clocking in from HQ office' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({
    example: 'Office - Floor 4',
    description:
      'Free-text location, or "lat,lng" coordinates (validated to lat -90..90, lng -180..180 when coordinate-shaped)',
  })
  @IsString()
  @IsOptional()
  @Validate(CoordinatesOrFreeText)
  @ValidateIf(o => o.location !== undefined && o.location !== '')
  location?: string;
}

export class ClockOutDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}

export class AttendanceQueryDto {
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

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ enum: AttendanceStatus })
  @IsEnum(AttendanceStatus)
  @IsOptional()
  status?: AttendanceStatus;
}

/** Phase 2, item 5 — attendance correction request. */
export class RequestCorrectionDto {
  @ApiProperty({ description: 'Attendance record to correct' })
  @IsUUID()
  @IsNotEmpty()
  attendanceRecordId: string;

  @ApiPropertyOptional({ example: '2026-10-05T09:05:00Z' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/, {
    message: 'clockInTime must be an ISO-8601 datetime',
  })
  @IsOptional()
  clockInTime?: string;

  @ApiPropertyOptional({ example: '2026-10-05T18:00:00Z' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/, {
    message: 'clockOutTime must be an ISO-8601 datetime',
  })
  @IsOptional()
  clockOutTime?: string;

  @ApiProperty({ example: 'Forgot to clock in; was in the office from 9' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** Phase 2, item 5 — manager/HR review of a correction request. */
export class ReviewCorrectionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsEnum(['APPROVE', 'REJECT'] as any)
  decision: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  remarks?: string;
}

export class CreateAttendanceCorrectionDto {
  @ApiPropertyOptional({ description: 'Attendance record to correct' })
  @IsUUID()
  attendanceRecordId!: string;

  @ApiPropertyOptional({ example: '2026-10-05T09:05:00.000Z' })
  @IsString()
  @IsOptional()
  requestedClockIn?: string;

  @ApiPropertyOptional({ example: '2026-10-05T17:35:00.000Z' })
  @IsString()
  @IsOptional()
  requestedClockOut?: string;

  @ApiPropertyOptional({ example: 'Forgot to clock in after the fire drill' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class DecideAttendanceCorrectionDto {
  @ApiPropertyOptional({ enum: ['APPROVED', 'REJECTED'] })
  @IsEnum(['APPROVED', 'REJECTED'] as any)
  status!: 'APPROVED' | 'REJECTED';
}
