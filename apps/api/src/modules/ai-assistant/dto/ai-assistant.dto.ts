import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AssistantAskDto {
  @ApiProperty({ example: 'How many annual leave days am I entitled to?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  question: string;

  @ApiPropertyOptional({
    description: 'Optional retrieval hints, e.g. ["policy", "my-leave-balance"]',
    example: ['policy', 'my-leave-balance'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  topics?: string[];
}

export class AssistantActionDto {
  @ApiProperty({ example: 'draft-leave-request' })
  @IsString()
  @IsNotEmpty()
  action: string;

  @ApiProperty({ description: 'Action payload; for draft-leave-request: { startDate, endDate, leaveTypeId?, reason? }' })
  payload: Record<string, any>;
}
