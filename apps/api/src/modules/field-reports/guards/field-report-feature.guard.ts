import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Controller-level feature flag gate: returns 404 FEATURE_DISABLED unless
 * FIELD_REPORTS_ENABLED=true so disabled deployments do not expose endpoints.
 */
@Injectable()
export class FieldReportFeatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(_context: ExecutionContext): boolean {
    const enabled = this.configService.get<boolean>('fieldReports.enabled', false);
    if (!enabled) {
      throw new NotFoundException({
        message: 'Field Reporting module is currently disabled.',
        error: 'FEATURE_DISABLED',
      });
    }
    return true;
  }
}

