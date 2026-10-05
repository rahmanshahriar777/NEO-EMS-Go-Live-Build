import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SETS_AUTH_COOKIES_KEY } from '../decorators/sets-auth-cookies.decorator';
import { getCookieValue } from '../../modules/auth/jwt.strategy';

/**
 * Phase 1 hardening, item 8 — CSRF protection for cookie-authenticated
 * mutations.
 *
 * Threat: the `ems_at` httpOnly cookie is sent automatically by the browser,
 * so a malicious site could forge state-changing requests (POST/PUT/PATCH/
 * DELETE) against the API from a victim's browser session.
 *
 * Defence in depth, two layers, both enforced only when the request is
 * cookie-authenticated (the `ems_at` cookie is present). API clients using the
 * Authorization header are exempt — they are not subject to ambient
 * browser-credential submission:
 *
 *  1. Origin/Referer validation: when an Origin (or, failing that, Referer)
 *     header is present it must match the CORS allowlist. Browsers always send
 *     one of these on cross-origin form/navigation requests; their absence is
 *     tolerated for non-browser clients.
 *  2. Double-submit CSRF token: the client echoes the value of the `csrf`
 *     cookie (set, non-httpOnly, on login) back in the `x-csrf-token` header.
 *     Compared with timingSafeEqual.
 *
 * P0-5 addition — cookie-ISSUING public routes: POST /auth/login,
 * POST /auth/refresh and POST /mfa/challenge are @Public() (no ems_at cookie
 * yet) but SET auth cookies on success, so the layers above never see them.
 * A forged top-level cross-origin POST to one of these would fix the
 * victim's browser to the attacker's session (session fixation / login
 * CSRF). Handlers that issue cookies are marked @SetsAuthCookies(); for
 * them the guard requires a present, allowlisted Origin/Referer — absent or
 * cross-origin is rejected. Requests carrying an Authorization header
 * (Bearer-token API/mobile clients) are exempt: they do not depend on
 * ambient cookie submission.
 *
 * Runs after JwtAuthGuard (it needs no user, but public routes and malformed
 * auth should short-circuit first). Skipped for safe methods (GET/HEAD/
 * OPTIONS) and @Public() routes that do not issue cookies.
 */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const setsAuthCookies = this.reflector.getAllAndOverride<boolean>(
      SETS_AUTH_COOKIES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic && !setsAuthCookies) {
      return true;
    }

    const req = context.switchToHttp().getRequest();

    if (setsAuthCookies) {
      // P0-5: this public route ISSUES auth cookies. A forged top-level
      // cross-origin POST would fix the victim's browser to the attacker's
      // session, so require a present, allowlisted Origin/Referer. Bearer
      // clients are exempt — they never rely on ambient cookie submission.
      const authorization = req.headers?.authorization as string | undefined;
      if (authorization && authorization.trim().toLowerCase().startsWith('bearer ')) {
        return true;
      }
      this.validateStrictOrigin(req);
      return true;
    }

    if (!STATE_CHANGING_METHODS.has((req.method as string)?.toUpperCase())) {
      return true;
    }

    // Only cookie-authenticated requests are CSRF-relevant. Header-auth
    // clients (mobile apps, curl, server-to-server) never send ems_at.
    const accessCookie = getCookieValue(req, 'ems_at');
    if (!accessCookie) {
      return true;
    }

    this.validateOrigin(req);
    this.validateDoubleSubmitToken(req);
    return true;
  }

  /**
   * Strict Origin/Referer validation for @SetsAuthCookies() routes.
   *
   * Unlike validateOrigin (which tolerates a missing header for non-browser
   * clients), these routes ISSUE auth cookies: a forged top-level
   * cross-origin POST is exactly the login-CSRF/session-fixation vector, and
   * browsers always send Origin (or Referer) on such requests. Absent or
   * cross-origin is therefore rejected; only non-browser clients that opt
   * into the Authorization-header exemption bypass this.
   */
  private validateStrictOrigin(req: any): void {
    const allowedOrigins = this.configService.get<string[]>('allowedOrigins', []);
    const origin = req.headers?.origin as string | undefined;
    const referer = req.headers?.referer as string | undefined;

    const candidate = origin || referer;
    if (!candidate) {
      this.logger.warn(
        `Blocked cookie-issuing auth request with no Origin/Referer: method=${req.method} path=${req.path}`,
      );
      throw new ForbiddenException('CSRF validation failed: Origin/Referer required');
    }

    let candidateOrigin: string;
    try {
      candidateOrigin = new URL(candidate).origin;
    } catch {
      throw new ForbiddenException('CSRF validation failed: malformed Origin/Referer');
    }

    if (!allowedOrigins.includes(candidateOrigin)) {
      this.logger.warn(
        `Blocked cross-origin cookie-issuing auth request: origin=${candidateOrigin} method=${req.method} path=${req.path}`,
      );
      throw new ForbiddenException('CSRF validation failed: origin not allowed');
    }
  }

  private validateOrigin(req: any): void {
    const allowedOrigins = this.configService.get<string[]>('allowedOrigins', []);
    const origin = req.headers?.origin as string | undefined;
    const referer = req.headers?.referer as string | undefined;

    const candidate = origin || referer;
    if (!candidate) {
      // No Origin/Referer: non-browser client (or same-origin navigation in
      // older browsers). The double-submit token below still protects.
      return;
    }

    let candidateOrigin: string;
    try {
      candidateOrigin = new URL(candidate).origin;
    } catch {
      throw new ForbiddenException('CSRF validation failed: malformed Origin/Referer');
    }

    if (!allowedOrigins.includes(candidateOrigin)) {
      this.logger.warn(
        `Blocked cross-origin cookie-authenticated mutation: origin=${candidateOrigin} method=${req.method} path=${req.path}`,
      );
      throw new ForbiddenException('CSRF validation failed: origin not allowed');
    }
  }

  private validateDoubleSubmitToken(req: any): void {
    const csrfCookieName = this.configService.get<string>('security.csrfCookieName', 'csrf');
    const cookieValue = getCookieValue(req, csrfCookieName);
    const headerValue = req.headers?.['x-csrf-token'] as string | undefined;

    if (!cookieValue || !headerValue || !this.tokensMatch(cookieValue, headerValue)) {
      throw new ForbiddenException('CSRF validation failed: missing or invalid CSRF token');
    }
  }

  private tokensMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }
}
