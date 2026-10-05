import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, Max, MaxLength } from 'class-validator';

export class AiGenerateDto {
  @ApiProperty({
    description: 'Prompt input for the AI model',
    example: 'Summarize standard annual leave carryover policy for full-time employees.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  prompt: string;

  @ApiPropertyOptional({
    description: 'Optional system context instruction',
    example: 'You are an enterprise HR assistant. Provide clear, accurate policy guidance.',
  })
  @IsString()
  @IsOptional()
  systemInstruction?: string;

  @ApiPropertyOptional({
    description: 'Sampling temperature (0.0 to 1.0)',
    default: 0.7,
    minimum: 0.0,
    maximum: 1.0,
  })
  @IsNumber()
  @IsOptional()
  @Min(0.0)
  @Max(1.0)
  temperature?: number;

  @ApiPropertyOptional({
    description: 'Maximum generation token limit',
    default: 2048,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(8192)
  maxTokens?: number;

  @ApiPropertyOptional({
    description: 'Specific model override if allowed by role',
    example: 'gemini-2.5-flash',
  })
  @IsString()
  @IsOptional()
  model?: string;
}

export class AiJobSubmitDto extends AiGenerateDto {
  @ApiPropertyOptional({
    description: 'Job type for asynchronous BullMQ queue dispatch',
    example: 'DOCUMENT_SUMMARIZATION',
    default: 'GENERAL_COMPLETION',
  })
  @IsString()
  @IsOptional()
  taskType?: string;
}
