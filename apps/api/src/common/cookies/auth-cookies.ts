import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as crypto from 'crypto';
import { TokensResponse } from '@ems/shared';
import { parseDurationMs } from '../../config/configuration';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../modules/auth/jwt.strategy';

/**
 * Item 8 — single cookie contract for auth tokens.
 *
 * - `ems_at`: access token, httpOnly, Path=/, maxAge = JWT_ACCESS_EXPIRATION.
 * - `ems_rt`: refresh token, httpOnly, Path=<apiPrefix>/auth, maxAge = JWT_REFRESH_EXPIRATION.
 * - `csrf`: double-submit CSRF token, NOT httpOnly (client JS must read it
 *   and echo it in the `x-csrf-token` header), SameSite=Lax, Secure in prod.
 *
 * Tokens are NEVER returned in JSON response bodies — cookies only.
 */
export function cookieFlags(config: ConfigService) {
  const isProduction = config.get<string>('nodeEnv') === 'production';
  return { httpOnly: true, secure: isProduction, sameSite: 'lax' as const };
}

export function refreshCookiePath(config: ConfigService): string {
  const apiPrefix = config.get<string>('apiPrefix', '/api/v1');
  return `${apiPrefix}/auth`;
}

export function setAuthCookies(
  res: Response,
  tokens: TokensResponse,
  config: ConfigService,
): void {
  const flags = cookieFlags(config);
  const accessTtlMs = parseDurationMs(
    config.get<string>('jwt.accessExpiration', '15m'),
    'JWT_ACCESS_EXPIRATION',
  );
  const refreshTtlMs = config.get<number>('jwt.refreshTtlMs', 7 * 24 * 60 * 60 * 1000);
  const csrfCookieName = config.get<string>('security.csrfCookieName', 'csrf');

  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...flags,
    maxAge: accessTtlMs,
    path: '/',
  });
  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...flags,
    maxAge: refreshTtlMs,
    path: refreshCookiePath(config),
  });
  // Rotate the double-submit CSRF token on every fresh session. Non-httpOnly
  // by design: the SPA reads it and echoes it in the x-csrf-token header.
  res.cookie(csrfCookieName, crypto.randomBytes(32).toString('hex'), {
    httpOnly: false,
    secure: flags.secure,
    sameSite: 'lax',
    maxAge: refreshTtlMs,
    path: '/',
  });
}

export function clearAuthCookies(res: Response, config: ConfigService): void {
  const csrfCookieName = config.get<string>('security.csrfCookieName', 'csrf');
  res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: refreshCookiePath(config) });
  res.clearCookie(csrfCookieName, { path: '/' });
}
