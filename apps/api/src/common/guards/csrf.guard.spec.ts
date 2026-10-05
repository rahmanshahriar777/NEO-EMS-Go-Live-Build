import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

/**
 * CsrfGuard tests (item 8): Origin/Referer validation + double-submit token,
 * enforced only for cookie-authenticated state-changing requests.
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
    isPublic?: boolean;
  }) {
    const headers: Record<string, string> = {};
    if (opts.cookies) headers['cookie'] = opts.cookies;
    if (opts.origin) headers['origin'] = opts.origin;
    if (opts.referer) headers['referer'] = opts.referer;
    if (opts.csrfHeader) headers['x-csrf-token'] = opts.csrfHeader;
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(opts.isPublic ?? false);
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          method: opts.method ?? 'POST',
          path: '/api/v1/leaves',
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
});
