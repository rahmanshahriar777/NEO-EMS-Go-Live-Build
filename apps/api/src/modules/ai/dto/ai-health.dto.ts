import { ApiProperty } from '@nestjs/swagger';

export class CircuitBreakerStateDto {
  @ApiProperty({ enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], example: 'CLOSED' })
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';

  @ApiProperty({ example: 0 })
  failureCount: number;

  @ApiProperty({ example: 5 })
  failureThreshold: number;

  @ApiProperty({ example: 30000 })
  recoveryWindowMs: number;

  @ApiProperty({ example: null, nullable: true })
  lastStateChange: string | null;
}

export class ProviderHealthDto {
  @ApiProperty({ example: 'gemini' })
  provider: string;

  @ApiProperty({ enum: ['healthy', 'degraded', 'unhealthy'], example: 'healthy' })
  status: 'healthy' | 'degraded' | 'unhealthy';

  @ApiProperty({ example: 'gemini-2.5-flash' })
  model: string;

  @ApiProperty({ type: CircuitBreakerStateDto })
  circuit: CircuitBreakerStateDto;

  @ApiProperty({ example: 450 })
  p50LatencyMs: number;

  @ApiProperty({ example: 980 })
  p95LatencyMs: number;

  @ApiProperty({ example: 0.02 })
  errorRate: number;

  @ApiProperty({ example: null, nullable: true })
  lastSuccessfulRequest: string | null;

  @ApiProperty({ example: null, nullable: true })
  lastError: string | null;

  @ApiProperty({ example: '2026-09-14T21:00:00.000Z' })
  checkedAt: string;
}

export class AiHealthResponseDto {
  @ApiProperty({ enum: ['healthy', 'degraded', 'unhealthy'], example: 'healthy' })
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';

  @ApiProperty({ description: 'Per-provider observability metrics' })
  providers: Record<string, ProviderHealthDto>;

  @ApiProperty({ example: 'gemini' })
  primaryProvider: string;

  @ApiProperty({ example: 'groq' })
  secondaryProvider: string;

  @ApiProperty({ example: '2026-09-14T21:00:00.000Z' })
  timestamp: string;
}
