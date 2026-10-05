import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

export class UploadDocumentDto {
  @ApiProperty({ example: 'Employment contract — signed' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({
    example: 'CONTRACT',
    description: 'Document category (e.g. RESUME, CONTRACT, POLICY, CERTIFICATE, GENERAL)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ description: 'Employee this document belongs to (HR only)' })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional({
    example: '2027-01-15',
    description: 'Expiry date (YYYY-MM-DD). Persisted once Document.expiresAt is migrated.',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiresAt must be YYYY-MM-DD' })
  @IsOptional()
  expiresAt?: string;
}

export class DocumentQueryDto {
  @ApiPropertyOptional({ description: 'Filter by owning employee (HR/admin only)' })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;
}
