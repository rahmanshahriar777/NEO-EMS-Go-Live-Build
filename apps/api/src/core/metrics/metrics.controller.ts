import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { metrics } from '@ems/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { SystemRole } from '@ems/shared';

/**
 * Guarded Prometheus metrics endpoint (Phase 1 observability, worker 6).
 *
 * NEVER public: metric labels can leak operational detail. Admin-only via
 * @Roles(); the global JwtAuthGuard + RolesGuard chain enforces it.
 * Renders the process-global shared registry (`@ems/shared` observability).
 */
@ApiTags('Operations')
@Controller('metrics')
export class MetricsController {
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN)
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Prometheus metrics scrape (admin only)' })
  scrape(): string {
    return metrics.renderPrometheus();
  }
}
