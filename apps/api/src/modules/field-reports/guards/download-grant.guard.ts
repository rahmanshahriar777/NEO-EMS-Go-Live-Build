import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { FieldReportDownloadVariant } from '@ems/shared';

export interface FieldReportDownloadGrantPayload {
  jti: string;
  purpose: 'field-report-download';
  scope: 'single' | 'zip';
  sub: string;
  empId?: string;
  reportId: string;
  revisionId?: string;
  attachmentId?: string;
  attachmentIds?: string[];
  variant: 'ORIGINAL' | 'RESIZED' | 'PREVIEW' | 'THUMBNAIL' | FieldReportDownloadVariant;
  disp: 'inline' | 'attachment';
  iat?: number;
  exp?: number;
}

export function resolveDownloadTokenSecret(configService: ConfigService): string {
  const configured = configService.get<string>('fieldReports.downloadTokenSecret')?.trim();
  const jwtSecret =
    configService.get<string>('jwt.accessSecret') || process.env.JWT_ACCESS_SECRET || 'dev-fallback';
  if (configured && configured.length > 0 && configured !== jwtSecret) {
    return configured;
  }
  const nodeEnv = configService.get<string>('nodeEnv', 'development');
  if (nodeEnv === 'production') {
    throw new Error(
      'FIELD_REPORT_DOWNLOAD_TOKEN_SECRET must be set and distinct in production when Field Reporting is active',
    );
  }
  // Domain-separated non-prod fallback key so download tokens can never collide with session keys.
  return createHash('sha256').update(`ems-fr-dl:${jwtSecret}`).digest('hex');
}

/**
 * Verifies short-lived signed download grant query tokens (?grant=<jwt>) using
 * the dedicated FIELD_REPORT_DOWNLOAD_TOKEN_SECRET and enforces
 * `purpose === 'field-report-download'`. Live DB/ACL checks follow inside DownloadGrantService.
 */
@Injectable()
export class DownloadGrantGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token =
      typeof req.query?.grant === 'string' && req.query.grant.trim().length > 0
        ? req.query.grant.trim()
        : null;

    if (!token) {
      throw new UnauthorizedException({
        message: 'Download grant token is required.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    let payload: FieldReportDownloadGrantPayload;
    try {
      payload = await this.jwtService.verifyAsync<FieldReportDownloadGrantPayload>(token, {
        secret: resolveDownloadTokenSecret(this.configService),
      });
    } catch {
      throw new UnauthorizedException({
        message: 'Download grant token is invalid or expired.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    if (
      !payload ||
      payload.purpose !== 'field-report-download' ||
      !payload.sub ||
      !payload.reportId ||
      (payload.scope !== 'single' && payload.scope !== 'zip')
    ) {
      throw new UnauthorizedException({
        message: 'Download grant token has invalid claims.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    req.downloadGrant = payload;
    return true;
  }
}
