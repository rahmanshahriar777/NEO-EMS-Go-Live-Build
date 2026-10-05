import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SalaryComponentType, CalculationType } from '@ems/shared';

export class SalaryComponentInputDto {
  @ApiProperty({ example: 'Basic Salary' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ enum: SalaryComponentType })
  @IsEnum(SalaryComponentType)
  type: SalaryComponentType;

  @ApiProperty({ enum: CalculationType })
  @IsEnum(CalculationType)
  calculationType: CalculationType;

  @ApiProperty({ example: 50, description: 'Percentage or fixed dollar amount' })
  @IsNumber()
  @Min(0)
  value: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isTaxable?: boolean = true;
}

export class CreateSalaryStructureDto {
  @ApiProperty({ example: 'Standard Engineering Structure' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Compensation plan with 50% basic and HRA' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ default: 'GBP', description: 'Defaults to PAYROLL_CURRENCY (GBP)' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ type: [SalaryComponentInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalaryComponentInputDto)
  components: SalaryComponentInputDto[];
}

export class AssignSalaryDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  salaryStructureId: string;

  @ApiProperty({ example: 9500.0 })
  @IsNumber()
  @IsPositive()
  baseSalary: number;

  @ApiProperty({ example: '2026-09-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effectiveFrom: string;
}

export class CreatePayrollRunDto {
  @ApiProperty({ example: 9, description: '1-12' })
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @ApiPropertyOptional({ description: 'Optional target department ID to run payroll by department' })
  @IsUUID()
  @IsOptional()
  departmentId?: string;
}

export class CreatePayslipCorrectionDto {
  @ApiProperty({ enum: SalaryComponentType, description: 'EARNING adds to gross, DEDUCTION adds to deductions' })
  @IsEnum(SalaryComponentType)
  type: SalaryComponentType;

  @ApiProperty({ example: 'Overtime correction — week 38' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @ApiProperty({ example: 150.0, description: 'Positive major-unit amount' })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({ example: 'Missed overtime from roster week 38' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
