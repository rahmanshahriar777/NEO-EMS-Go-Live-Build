import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisCacheService } from '../../core/redis/redis-cache.service';
import { JwtPayload } from '@ems/shared';

/**
 * F16: httpOnly cookie names. Access tokens ride `ems_at`; the refresh token
 * cookie (`ems_rt`) is only ever read by the refresh/logout endpoints.
 */
export const ACCESS_TOKEN_COOKIE = 'ems_at';
export const REFRESH_TOKEN_COOKIE = 'ems_rt';

/**
 * Extract the access token from the `ems_at` httpOnly cookie without
 * depending on cookie-parser: parse the raw Cookie header manually.
 */
export function getCookieValue(req: any, name: string): string | null {
  const cookieHeader: string | undefined = req?.headers?.cookie;
  if (!cookieHeader) {
    return null;
  }
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function extractTokenFromCookie(req: any): string | null {
  return getCookieValue(req, ACCESS_TOKEN_COOKIE);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {
    // F3: no 'default-fallback-secret' — fail closed at startup instead.
    // validateRequiredSecrets() in main.ts already throws in production when
    // JWT_ACCESS_SECRET is unset; this is defence in depth.
    const secret = configService.get<string>('jwt.accessSecret');
    if (!secret) {
      throw new Error(
        '[auth] JWT_ACCESS_SECRET is not configured — refusing to start. ' +
          'Set JWT_ACCESS_SECRET in the environment.',
      );
    }

    super({
      // F16 (transition period): accept the token from the httpOnly cookie OR
      // the Authorization header so existing header-based clients keep working
      // while the web app migrates to cookies.
      jwtFromRequest: ExtractJwt.fromExtractors([
        extractTokenFromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Per-request user check — now served from the Redis cache when warm
   * (go-live hardening, §5 performance: this used to hit Postgres on every
   * request).
   *
   * Semantics are unchanged: unknown/missing users and inactive users are
   * rejected. Cache failures degrade to the database (fail-open for reads);
   * a null cache entry means "unknown", never "active".
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Fast path: cached isActive flag (60s TTL).
    const cachedActive = await this.cache.getUserActive(payload.sub);
    if (cachedActive !== null) {
      if (!cachedActive) {
        throw new UnauthorizedException('User account is inactive or deleted');
      }
      return payload;
    }

    // Cache miss or Redis down: database, then repopulate the cache.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, isActive: true },
    });

    const active = !!user?.isActive;
    // Best-effort: never let a cache write failure fail the request.
    await this.cache.setUserActive(payload.sub, active);

    if (!active) {
      throw new UnauthorizedException('User account is inactive or deleted');
    }

    return payload;
  }
}
