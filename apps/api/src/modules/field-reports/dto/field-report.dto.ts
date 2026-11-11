import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  FieldReportCategory,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  FieldReportStatus,
  GPS_CONSENT_POLICY_VERSION,
} from '@ems/shared';

export class CreateFieldReportDto {
  @ApiProperty({ example: 'Substation B4 Roof Leak Inspection', maxLength: 160 })
  @IsString()
  @Length(3, 160)
  title!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiProperty({ enum: FieldReportCategory, default: FieldReportCategory.SITE_INSPECTION })
  @IsEnum(FieldReportCategory)
  category!: FieldReportCategory;

  @ApiPropertyOptional({ example: '2026-11-10T14:30:00.000Z' })
  @IsOptional()
  @IsString()
  occurredAt?: string;

  @ApiPropertyOptional({ example: '2026-11-10T14:30:00.000Z' })
  @IsOptional()
  @IsString()
  incidentAt?: string;

  @ApiPropertyOptional({ example: 'default-north-depot' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  siteId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  gpsConsentGranted?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  gpsConsent?: boolean;

  @ApiPropertyOptional({ example: GPS_CONSENT_POLICY_VERSION })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  gpsConsentPolicyVersion?: string;

  @ApiPropertyOptional({ example: 51.507351 })
  @IsOptional()
  @ValidateIf((o) => o.gpsLatitude !== undefined && o.gpsLatitude !== null)
  @IsNumber()
  @Min(-90)
  @Max(90)
  gpsLatitude?: number;

  @ApiPropertyOptional({ example: 51.507351 })
  @IsOptional()
  @ValidateIf((o) => o.latitude !== undefined && o.latitude !== null)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: -0.127758 })
  @IsOptional()
  @ValidateIf((o) => o.gpsLongitude !== undefined && o.gpsLongitude !== null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  gpsLongitude?: number;

  @ApiPropertyOptional({ example: -0.127758 })
  @IsOptional()
  @ValidateIf((o) => o.longitude !== undefined && o.longitude !== null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ example: 6.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  gpsAccuracyMeters?: number;

  @ApiPropertyOptional({ example: 6.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ example: '2026-11-10T14:29:52.000Z' })
  @IsOptional()
  @IsString()
  gpsCapturedAt?: string;
}

export class UpdateFieldReportDto extends PartialType(CreateFieldReportDto) {}

export class FieldReportQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: FieldReportStatus })
  @IsOptional()
  @IsEnum(FieldReportStatus)
  status?: FieldReportStatus;

  @ApiPropertyOptional({ enum: FieldReportCategory })
  @IsOptional()
  @IsEnum(FieldReportCategory)
  category?: FieldReportCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unassignedManagerOnly?: boolean;
}

export class ReviewFieldReportDto {
  @ApiProperty({ enum: FieldReportReviewDecision })
  @IsEnum(FieldReportReviewDecision)
  decision!: FieldReportReviewDecision;

  @ApiPropertyOptional({ description: 'Required for REJECT and REQUEST_CHANGES' })
  @ValidateIf((o) => o.decision !== FieldReportReviewDecision.APPROVE)
  @IsString()
  @Length(5, 2000)
  reason?: string;
}

export class CreateFieldReportCommentDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @Length(1, 2000)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}

export class CreateUploadSessionDto {
  @ApiPropertyOptional({ example: 'roof_damage_01.jpg', maxLength: 255 })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  originalFileName?: string;

  @ApiPropertyOptional({ example: 'roof_damage_01.jpg', maxLength: 255 })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  fileName?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  claimedMimeType?: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @ApiPropertyOptional({ example: 2048576, minimum: 1, maximum: 52428800 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declaredSizeBytes?: number;

  @ApiPropertyOptional({ example: 2048576, minimum: 1, maximum: 52428800 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  byteSize?: number;

  @ApiPropertyOptional({ description: 'Client precomputed hex SHA-256 of Original' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/i)
  declaredSha256?: string;

  @ApiPropertyOptional({ description: 'Client precomputed hex SHA-256 of Original' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/i)
  clientSha256?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'IndexedDB idempotency token' })
  @IsOptional()
  @IsUUID()
  clientCaptureId?: string;
}

export type RequestedDownloadVariant = 'ORIGINAL' | 'RESIZED' | 'PREVIEW' | 'THUMBNAIL';

export class CreateDownloadGrantDto {
  @ApiProperty({ enum: ['ORIGINAL', 'RESIZED', 'PREVIEW', 'THUMBNAIL'] })
  @IsIn(['ORIGINAL', 'RESIZED', 'PREVIEW', 'THUMBNAIL'])
  variant!: RequestedDownloadVariant;

  @ApiPropertyOptional({ enum: ['inline', 'attachment'], default: 'attachment' })
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}

export class CreateZipDownloadGrantDto {
  @ApiProperty({ enum: FieldReportDownloadVariant })
  @IsEnum(FieldReportDownloadVariant)
  variant!: FieldReportDownloadVariant;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

export class UpdateFieldReportPolicyDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  entityId?: string | null;

  @ApiPropertyOptional({ example: 'MANAGER', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  roleName?: string | null;

  @ApiProperty({ enum: FieldReportDownloadVariant })
  @IsEnum(FieldReportDownloadVariant)
  defaultDownloadVariant!: FieldReportDownloadVariant;

  @ApiProperty()
  @IsBoolean()
  allowOriginalDownload!: boolean;

  @ApiPropertyOptional({ minimum: 30, maximum: 3650, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3650)
  retentionDaysOverride?: number | null;

  @ApiPropertyOptional({ enum: FieldReportCategory, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(FieldReportCategory, { each: true })
  requireGpsForCategories?: FieldReportCategory[];
}

export class CreateDelegationDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Optional for HR/Admin; Managers default to self' })
  @IsOptional()
  @IsUUID()
  delegatorEmployeeId?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  delegateEmployeeId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  entityId?: string;

  @ApiProperty({ example: '2026-11-12T00:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ example: '2026-11-26T23:59:59.000Z' })
  @IsISO8601()
  endsAt!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class DownloadGrantResponseDto {
  @ApiProperty()
  grantToken!: string;

  @ApiProperty()
  expiresAt!: string;

  @ApiProperty()
  downloadUrl!: string;

  @ApiProperty()
  variantServed!: string;

  @ApiProperty()
  fileName!: string;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  fileSizeBytes!: number;
}

