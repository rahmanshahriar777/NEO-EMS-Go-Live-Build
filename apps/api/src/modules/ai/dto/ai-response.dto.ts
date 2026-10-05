import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AiUsageDto {
  @ApiPropertyOptional({ example: 120 })
  promptTokens?: number;

  @ApiPropertyOptional({ example: 340 })
  completionTokens?: number;

  @ApiPropertyOptional({ example: 460 })
  totalTokens?: number;
}

export class AiResponseDto {
  @ApiProperty({ description: 'AI-generated response text' })
  content: string;

  @ApiProperty({ description: 'Active provider that served the request', example: 'gemini' })
  provider: 'gemini' | 'groq';

  @ApiProperty({ description: 'Model identifier used for generation', example: 'gemini-2.5-flash' })
  model: string;

  @ApiProperty({ description: 'Execution roundtrip latency in milliseconds', example: 642 })
  latencyMs: number;

  @ApiProperty({ description: 'Whether automatic failover was triggered', example: false })
  failoverUsed: boolean;

  @ApiPropertyOptional({ description: 'Diagnostic reason if failover occurred' })
  failoverReason?: string;

  @ApiPropertyOptional({ type: AiUsageDto })
  usage?: AiUsageDto;

  @ApiProperty({ description: 'Unique trace identifier for audit correlation' })
  requestId: string;

  @ApiProperty({ description: 'ISO timestamp of generation' })
  timestamp: string;
}

export class AiErrorProviderAttempt {
  provider: string;
  model: string;
  error: string;
  latencyMs: number;
}

export class AiServiceUnavailableDto {
  @ApiProperty({ example: 503 })
  statusCode: number;

  @ApiProperty({ example: 'All configured AI providers are currently unavailable.' })
  message: string;

  @ApiProperty({ example: 'AI_OUTAGE_ALL_PROVIDERS_FAILED' })
  errorCode: string;

  @ApiProperty({ description: 'Summary of provider attempts and failure causes' })
  attempts: AiErrorProviderAttempt[];

  @ApiProperty({ description: 'Suggested client retry delay in seconds', example: 30 })
  retryAfterSeconds: number;

  @ApiProperty({ description: 'Timestamp of the outage event' })
  timestamp: string;
}
