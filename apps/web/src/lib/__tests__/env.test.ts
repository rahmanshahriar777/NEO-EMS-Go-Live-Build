import { describe, it, expect, afterEach } from 'vitest';
import { isPublicRegistrationEnabled } from '../env';

const KEY = 'NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION';

describe('isPublicRegistrationEnabled (/register gate)', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it('defaults to false (invitation-only) when unset', () => {
    expect(isPublicRegistrationEnabled()).toBe(false);
  });

  it('returns true only for the exact string "true"', () => {
    process.env[KEY] = 'true';
    expect(isPublicRegistrationEnabled()).toBe(true);
  });

  it('treats any other value as disabled', () => {
    for (const v of ['false', '0', 'yes', 'TRUE', '']) {
      process.env[KEY] = v;
      expect(isPublicRegistrationEnabled()).toBe(false);
    }
  });
});
