/**
 * configuration.ts pure-function tests: parseDurationMs + validateRequiredSecrets.
 *
 * These are the fail-fast config gates — cheap to pin, expensive to get wrong
 * in production.
 */
import { parseDurationMs, validateRequiredSecrets } from './configuration';

describe('parseDurationMs', () => {
  it('parses milliseconds, seconds, minutes, hours, days', () => {
    expect(parseDurationMs('500ms', 'X')).toBe(500);
    expect(parseDurationMs('30s', 'X')).toBe(30_000);
    expect(parseDurationMs('15m', 'X')).toBe(900_000);
    expect(parseDurationMs('2h', 'X')).toBe(7_200_000);
    expect(parseDurationMs('7d', 'X')).toBe(604_800_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDurationMs('3600', 'X')).toBe(3_600_000);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseDurationMs(' 15M ', 'X')).toBe(900_000);
  });

  it('throws a helpful error on garbage', () => {
    expect(() => parseDurationMs('soon', 'JWT_ACCESS_EXPIRATION')).toThrow(
      /JWT_ACCESS_EXPIRATION.*invalid duration/,
    );
    expect(() => parseDurationMs('', 'X')).toThrow(/invalid duration/);
  });
});

describe('validateRequiredSecrets', () => {
  const KEYS = [
    'NODE_ENV',
    'DATABASE_URL',
    'JWT_ACCESS_SECRET',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'SMTP_HOST',
    'OAUTH_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_REDIRECT_URI',
    'JWT_REFRESH_EXPIRATION',
    'JWT_ACCESS_EXPIRATION',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const allSecrets = () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/x';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.S3_ACCESS_KEY = 'key';
    process.env.S3_SECRET_KEY = 'secret';
  };

  it('passes silently when all required secrets are set (non-production)', () => {
    process.env.NODE_ENV = 'test';
    allSecrets();
    expect(() => validateRequiredSecrets()).not.toThrow();
  });

  it('throws in production when secrets are missing', () => {
    process.env.NODE_ENV = 'production';
    expect(() => validateRequiredSecrets()).toThrow(/Missing required secrets/);
  });

  it('warns (not throws) outside production when secrets are missing', () => {
    process.env.NODE_ENV = 'development';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => validateRequiredSecrets()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing required secrets'));
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects malformed durations even in dev', () => {
    process.env.NODE_ENV = 'development';
    allSecrets();
    process.env.JWT_ACCESS_EXPIRATION = 'soon';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      validateRequiredSecrets();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('JWT_ACCESS_EXPIRATION'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('requires SMTP_HOST in production', () => {
    process.env.NODE_ENV = 'production';
    allSecrets();
    expect(() => validateRequiredSecrets()).toThrow(/SMTP_HOST/);
  });
});
