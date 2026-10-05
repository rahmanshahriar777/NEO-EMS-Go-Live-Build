import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsEmail,
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
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmploymentStatus, Gender } from '@ems/shared';

/** ISO calendar date (YYYY-MM-DD). Stored as UTC midnight; see time utils. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEmployeeDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'Rahman' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lastName: string;

  @ApiProperty({ example: 'sadia.rahman@ems.local' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ example: '+1 (555) 123-4567' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ example: '1990-05-15' })
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'dateOfBirth must be YYYY-MM-DD' })
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiPropertyOptional({ example: '123 Main St, New York, NY' })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  address?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  designationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  managerId?: string;

  @ApiPropertyOptional({ example: '2024-06-01' })
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'joiningDate must be YYYY-MM-DD' })
  @IsOptional()
  joiningDate?: string;

  @ApiPropertyOptional({ enum: EmploymentStatus, default: EmploymentStatus.FULL_TIME })
  @IsEnum(EmploymentStatus)
  @IsOptional()
  status?: EmploymentStatus;

  @ApiPropertyOptional({ example: 'Senior backend architect' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  profileSummary?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarUrl?: string;

  // -------------------------------------------------------------------------
  // Extended profile (Phase 2, item 3). Schema needs (worker 4):
  //   Employee.emergencyContact Json?
  //   Employee.contractStart   DateTime?
  //   Employee.contractEnd     DateTime?
  //   Employee.workLocation    String?
  //   Employee.bankAccountEnc  String?   (encrypted at rest, HR-only)
  //   Employee.taxIdEnc        String?   (encrypted at rest, HR-only)
  //   Employee.timezone        String?   (IANA, e.g. "Europe/London")
  //   Employee.entityId        String?   (Phase 3 multi-entity scoping)
  // -------------------------------------------------------------------------

  @ApiPropertyOptional({
    description: 'Emergency contact { name, relationship, phone }',
    example: { name: 'Jane Rahman', relationship: 'Spouse', phone: '+1 (555) 987-6543' },
  })
  @IsOptional()
  emergencyContact?: Record<string, any>;

  // Flat emergency-contact fields as sent by the web UI (employee-form-modal).
  // Normalized into `emergencyContact` on write; also read back flat.
  @ApiPropertyOptional({ example: 'Jane Rahman' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  emergencyContactName?: string;

  @ApiPropertyOptional({ example: '+1 (555) 987-6543' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  emergencyContactPhone?: string;

  @ApiPropertyOptional({ example: 'Spouse' })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  emergencyContactRelation?: string;

  @ApiPropertyOptional({ example: '2024-06-01' })
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'contractStart must be YYYY-MM-DD' })
  @IsOptional()
  contractStart?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'contractEnd must be YYYY-MM-DD' })
  @IsOptional()
  contractEnd?: string;

  @ApiPropertyOptional({
    example: '2026-05-31',
    description: 'Alias for contractEnd (field name sent by the web UI)',
  })
  @IsString()
  @Matches(ISO_DATE_PATTERN, { message: 'contractEndDate must be YYYY-MM-DD' })
  @IsOptional()
  contractEndDate?: string;

  @ApiPropertyOptional({ example: 'London HQ — Floor 4' })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  workLocation?: string;

  @ApiPropertyOptional({ description: 'Bank account identifier (encrypted at rest; HR-only)' })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  bankAccountEnc?: string;

  @ApiPropertyOptional({ description: 'Tax identifier (encrypted at rest; HR-only)' })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  taxIdEnc?: string;

  @ApiPropertyOptional({ example: 'Europe/London', description: 'IANA timezone for shift/day boundaries' })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  timezone?: string;
}

/**
 * Phase 1 refactoring: UpdateEmployeeDto is now PartialType(CreateEmployeeDto)
 * instead of a full re-declaration — every field optional, same validators.
 */
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

/**
 * A1: fields a MANAGER may change on a DIRECT REPORT via PATCH /employees/:id.
 * Identity, employment terms and compensation-adjacent fields are HR-only:
 * no role/status/email/department/designation/manager/contract changes.
 */
export const MANAGER_EDITABLE_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'address',
  'profileSummary',
  'avatarUrl',
  'workLocation',
  'emergencyContact',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
  'timezone',
] as const;

export class EmployeeQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 10;

  @ApiPropertyOptional({ description: 'Search by name, email, or employee number' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  designationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  managerId?: string;

  @ApiPropertyOptional({ enum: EmploymentStatus })
  @IsEnum(EmploymentStatus)
  @IsOptional()
  status?: EmploymentStatus;

  @ApiPropertyOptional({ description: 'Phase 3 multi-entity scoping (Entity id)' })
  @IsUUID()
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional({
    default: 'createdAt',
    description: 'Sort field (allowlisted)',
    enum: ['createdAt', 'firstName', 'lastName', 'email', 'employeeNumber', 'joiningDate', 'updatedAt'],
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

export class UpdateAvatarDto {
  @ApiPropertyOptional({
    description: 'Profile picture image URL or Base64 data URI (send null or empty string to remove)',
    example: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330',
  })
  @IsString()
  @IsOptional()
  avatarUrl?: string;
}

/** Phase 1 refactoring: sortBy allowlist for employee listing. */
export const EMPLOYEE_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'firstName',
  'lastName',
  'email',
  'employeeNumber',
  'joiningDate',
] as const;
