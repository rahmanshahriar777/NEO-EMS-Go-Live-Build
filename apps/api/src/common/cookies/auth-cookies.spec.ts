/**
 * auth-cookies contract tests: the single cookie contract for auth tokens
 * (item 8). Pins: httpOnly session cookies, maxAge from config durations,
 * CSRF cookie non-httpOnly by design, and the clear path.
 */
import { ConfigService } from '@nestjs/config';
import { setAuthCookies, clearAuthCookies } from './auth-cookies';

const config = (overrides: Record<string, any> = {}) => {
  const values: Record<string, any> = {
    nodeEnv: 'test',
    'jwt.accessExpiration': '15m',
    'jwt.refreshTtlMs': 7 * 24 * 60 * 60 * 1000,
    'security.csrfCookieName': 'csrf',
    apiPrefix: '/api/v1',
    ...overrides,
  };
  return { get: (k: string, f?: any) => (k in values ? values[k] : f) } as ConfigService;
};

const tokens: any = { accessToken: 'at', refreshToken: 'rt' };

describe('setAuthCookies', () => {
  it('sets httpOnly access + refresh cookies with config durations', () => {
    const res: any = { cookie: jest.fn() };
    setAuthCookies(res, tokens, config());

    expect(res.cookie).toHaveBeenCalledWith(
      expect.any(String),
      'at',
      expect.objectContaining({ httpOnly: true, maxAge: 900_000, path: '/' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      expect.any(String),
      'rt',
      expect.objectContaining({
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      }),
    );
  });

  it('sets a non-httpOnly CSRF cookie (SPA reads it by design)', () => {
    const res: any = { cookie: jest.fn() };
    setAuthCookies(res, tokens, config());

    const csrfCall = res.cookie.mock.calls.find((c: any[]) => c[0] === 'csrf');
    expect(csrfCall).toBeDefined();
    expect(csrfCall[2]).toEqual(
      expect.objectContaining({ httpOnly: false, sameSite: 'lax', path: '/' }),
    );
    expect(typeof csrfCall[1]).toBe('string');
    expect(csrfCall[1]).toHaveLength(64); // 32 random bytes, hex
  });

  it('marks cookies Secure in production', () => {
    const res: any = { cookie: jest.fn() };
    setAuthCookies(res, tokens, config({ nodeEnv: 'production' }));

    for (const call of res.cookie.mock.calls) {
      expect(call[2].secure).toBe(true);
    }
  });

  it('uses the configured CSRF cookie name', () => {
    const res: any = { cookie: jest.fn() };
    setAuthCookies(res, tokens, config({ 'security.csrfCookieName': 'my-csrf' }));
    expect(res.cookie.mock.calls.some((c: any[]) => c[0] === 'my-csrf')).toBe(true);
  });
});

describe('clearAuthCookies', () => {
  it('clears all three cookies with the right paths', () => {
    const res: any = { clearCookie: jest.fn() };
    clearAuthCookies(res, config());

    expect(res.clearCookie).toHaveBeenCalledWith(expect.any(String), { path: '/' });
    expect(res.clearCookie).toHaveBeenCalledWith(expect.any(String), {
      path: '/api/v1/auth',
    });
    expect(res.clearCookie).toHaveBeenCalledWith('csrf', { path: '/' });
    expect(res.clearCookie).toHaveBeenCalledTimes(3);
  });
});
