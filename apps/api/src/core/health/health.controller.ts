import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Health probes are intentionally public (load balancers / k8s probes carry
 * no credentials) — class-level @Public(). Response bodies are trimmed to
 * status signals only: no memory figures, versions, or other fingerprintable
 * internals (Phase 1 hardening, item 10).
 */
@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness probe endpoint' })
  liveness() {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: 200 when both dependencies are reachable, 503 otherwise so
   * the orchestrator stops routing traffic to an unready replica.
   */
  @Get('readiness')
  @ApiOperation({ summary: 'Readiness probe inspecting DB and Redis dependencies' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    let dbUp = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbUp = true;
    } catch {
      dbUp = false;
    }

    const redisUp = this.redis.getIsConnected();
    const ready = dbUp && redisUp;

    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? 'UP' : 'DOWN',
      timestamp: new Date().toISOString(),
      services: {
        database: dbUp ? 'UP' : 'DOWN',
        redis: redisUp ? 'UP' : 'DOWN',
      },
    };
  }
}
