import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AiOrchestratorService } from './orchestrator/ai-orchestrator.service';
import { AiAuditService } from './audit/ai-audit.service';
import { AiGenerateDto, AiJobSubmitDto } from './dto/ai-generate.dto';
import { AiResponseDto, AiServiceUnavailableDto } from './dto/ai-response.dto';
import { AiHealthResponseDto } from './dto/ai-health.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SystemRole } from '@ems/shared';
import { Throttle } from '@nestjs/throttler';

@ApiTags('AI Inference Layer')
@Controller('ai')
export class AiController {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly auditService: AiAuditService,
  ) {}

  // F4: previously completely unguarded — an open LLM proxy on company keys.
  // Generation is restricted to HR roles (SUPER_ADMIN bypasses via RolesGuard)
  // and throttled hard (20 req/min per-route @Throttle override) to bound
  // provider spend.
  @Post('generate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Generate AI completion with automatic dual-provider failover',
    description:
      'Routes prompt to Google Gemini 2.5 Flash by default, with automatic circuit-breaker-protected failover to Groq Cloud (Llama 3.3 70B) upon timeout, rate limit, or outage.',
  })
  @ApiResponse({
    status: 200,
    description: 'AI completion generated successfully',
    type: AiResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: 'All AI providers unavailable or open circuit',
    type: AiServiceUnavailableDto,
  })
  async generate(
    @Body() dto: AiGenerateDto,
    @Req() req: any,
  ): Promise<AiResponseDto> {
    const actor = req?.user
      ? { id: req.user.id || req.user.sub, email: req.user.email }
      : undefined;

    return this.orchestrator.generate(
      dto.prompt,
      {
        model: dto.model,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
      },
      actor,
    );
  }

  // F4: previously unguarded. Circuit-breaker state is operationally
  // sensitive; require authentication (any role passes — RolesGuard with no
  // @Roles metadata is a passthrough).
  @Get('health')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'AI Provider Health & Circuit Breaker Observability',
    description:
      'Returns per-provider circuit breaker state, rolling latency percentiles (p50/p95), error rates, and health status.',
  })
  @ApiResponse({
    status: 200,
    description: 'AI health and circuit status',
    type: AiHealthResponseDto,
  })
  async getHealth(): Promise<AiHealthResponseDto> {
    return this.orchestrator.getHealthStatus();
  }

  @Get('logs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Get token-level AI audit logs (Admin only)',
    description: 'Returns historical audit trail of AI completions with token counts, latency, and provider attribution.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async getLogs(@Query('limit') limit = 20) {
    return this.auditService.getRecentLogs(Number(limit) || 20);
  }
}
