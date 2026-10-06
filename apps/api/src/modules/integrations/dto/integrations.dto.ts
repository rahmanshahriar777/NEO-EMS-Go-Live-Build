import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SendAlertDto {
  @ApiProperty({ description: 'Title of the alert notification', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: 'Message body of the alert', maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;

  @ApiPropertyOptional({ description: 'Optional destination link URL' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  linkUrl?: string;
}

export class HrisEmployeeImportItemDto {
  @ApiProperty({ description: 'Employee first name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ description: 'Employee last name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ description: 'Corporate email address' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ description: 'Department code identifier', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  departmentCode?: string;

  @ApiPropertyOptional({ description: 'Designation title identifier', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  designationTitle?: string;

  @ApiPropertyOptional({ description: 'Contact phone number', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class ImportHrisDto {
  @ApiProperty({
    type: [HrisEmployeeImportItemDto],
    description: 'Array of employee roster items to synchronize',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => HrisEmployeeImportItemDto)
  employees!: HrisEmployeeImportItemDto[];
}
