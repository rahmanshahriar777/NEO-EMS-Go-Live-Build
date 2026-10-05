import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SETS_AUTH_COOKIES_KEY } from '../decorators/sets-auth-cookies.decorator';

/**
 * CsrfGuard tests (item 8): Origin/Referer validation + double-submit token,
 * enforced only for cookie-authenticated state-changing requests.
 *
 * P0-5 tests: @SetsAuthCookies() routes (POST /auth/login, /auth/refresh,
 * /mfa/challenge) require a present, allowlisted Origin/Referer unless the
 * request carries an Authorization header (Bearer API clients).
 */
describe('CsrfGuard', () => {
  let guard: CsrfGuard;
  let reflector: Reflector;
  let configGet: jest.Mock;

  const allowedOrigins = ['http://localhost:3000', 'https://ems.example.com'];

  function ctx(opts: {
    method?: string;
    cookies?: string;
    origin?: string;
    referer?: string;
    csrfHeader?: string;
    authorization?: string;
    isPublic?: boolean;
    setsAuthCookies?: boolean;
  }) {
    const headers: Record<string, string> = {};
    if (opts.cookies) headers['cookie'] = opts.cookies;
    if (opts.origin) headers['origin'] = opts.origin;
    if (opts.referer) headers['referer'] = opts.referer;
    if (opts.csrfHeader) headers['x-csrf-token'] = opts.csrfHeader;
    if (opts.authorization) headers['authorization'] = opts.authorization;
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
      if (key === IS_PUBLIC_KEY) return opts.isPublic ?? false;
      if (key === SETS_AUTH_COOKIES_KEY) return opts.setsAuthCookies ?? false;
      return false;
    });
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          method: opts.method ?? 'POST',
          path: '/api/v1/auth/login',
          headers,
        }),
      }),
    } as any;
  }

  beforeEach(() => {
    reflector = new Reflector();
    configGet = jest.fn((key: string, fallback?: any) => {
      if (key === 'allowedOrigins') return allowedOrigins;
      if (key === 'security.csrfCookieName') return 'csrf';
      return fallback;
    });
    guard = new CsrfGuard(reflector, { get: configGet } as unknown as ConfigService);
  });

  it('passes safe methods (GET) without checks', () => {
    expect(guard.canActivate(ctx({ method: 'GET', cookies: 'ems_at=tok' }))).toBe(true);
  });

  it('passes @Public() routes without checks', () => {
    expect(
      guard.canActivate(ctx({ method: 'POST', cookies: 'ems_at=tok', isPublic: true })),
    ).toBe(true);
  });

  it('passes header-authenticated mutations (no ems_at cookie)', () => {
    expect(guard.canActivate(ctx({ method: 'POST' }))).toBe(true);
  });

  it('passes a cookie-authenticated mutation with matching origin and CSRF token', () => {
    const c = ctx({
      method: 'POST',
      cookies: 'ems_at=tok; csrf=secret123',
      origin: 'http://localhost:3000',
      csrfHeader: 'secret123',
    });
    expect(guard.canActivate(c)).toBe(true);
  });

  it('passes when only Referer is present and matches', () => {
    const c = ctx({
      method: 'PATCH',
      cookies: 'ems_at=tok; csrf=abc',
      referer: 'https://ems.example.com/app/leaves',
      csrfHeader: 'abc',
    });
    expect(guard.canActivate(c)).toBe(true);
  });

  it('rejects a cross-origin cookie-authenticated mutation', () => {
    const c = ctx({
      method: 'POST',
      cookies: 'ems_at=tok; csrf=secret123',
      origin: 'https://evil.example',
      csrfHeader: 'secret123',
    });
    expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
  });

  it('rejects when the CSRF header is missing', () => {
    const c = ctx({
      method: 'POST',
      cookies: 'ems_at=tok; csrf=secret123',
      origin: 'http://localhost:3000',
    });
    expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
  });

  it('rejects when the CSRF header does not match the cookie', () => {
    const c = ctx({
      method: 'DELETE',
      cookies: 'ems_at=tok; csrf=secret123',
      origin: 'http://localhost:3000',
      csrfHeader: 'attacker-guess',
    });
    expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
  });

  it('tolerates absent Origin/Referer for non-browser clients (token still required)', () => {
    const c = ctx({
      method: 'POST',
      cookies: 'ems_at=tok; csrf=secret123',
      csrfHeader: 'secret123',
    });
    expect(guard.canActivate(c)).toBe(true);
  });

  it('rejects a malformed Origin', () => {
    const c = ctx({
      method: 'POST',
      cookies: 'ems_at=tok; csrf=secret123',
      origin: '::::not-a-url',
      csrfHeader: 'secret123',
    });
    expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
  });

  describe('P0-5: cookie-issuing auth routes (@SetsAuthCookies)', () => {
    it('rejects a cross-origin login POST (login CSRF / session fixation)', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        origin: 'https://evil.example',
      });
      expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
    });

    it('rejects a login POST with a cross-origin Referer and no Origin', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        referer: 'https://evil.example/phish',
      });
      expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
    });

    it('rejects a login POST with no Origin/Referer at all', () => {
      const c = ctx({ method: 'POST', isPublic: true, setsAuthCookies: true });
      expect(() => guard.canActivate(c)).toThrow(/Origin\/Referer required/);
    });

    it('rejects a malformed Origin on a cookie-issuing route', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        origin: '::::not-a-url',
      });
      expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
    });

    it('allows a same-origin login POST', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        origin: 'https://ems.example.com',
      });
      expect(guard.canActivate(c)).toBe(true);
    });

    it('allows a same-origin Referer when Origin is absent', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        referer: 'http://localhost:3000/login',
      });
      expect(guard.canActivate(c)).toBe(true);
    });

    it('exempts the Bearer-token API flow (Authorization header present)', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        origin: 'https://evil.example',
        authorization: 'Bearer some-api-token',
      });
      expect(guard.canActivate(c)).toBe(true);
    });

    it('exempts Bearer clients that send no Origin at all', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        authorization: 'Bearer some-api-token',
      });
      expect(guard.canActivate(c)).toBe(true);
    });

    it('does not apply the strict check to other public routes', () => {
      const c = ctx({ method: 'POST', isPublic: true });
      expect(guard.canActivate(c)).toBe(true);
    });

    it('still applies the strict check when a non-Bearer Authorization header is sent', () => {
      const c = ctx({
        method: 'POST',
        isPublic: true,
        setsAuthCookies: true,
        authorization: 'Basic dXNlcjpwYXNz',
      });
      expect(() => guard.canActivate(c)).toThrow(ForbiddenException);
    });
  });
});
