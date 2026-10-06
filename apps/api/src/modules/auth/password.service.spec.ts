import { BadRequestException } from '@nestjs/common';
import { PasswordService } from './password.service';

/**
 * Password service tests (Phase 1 hardening):
 *  - new hashes are Argon2id in PHC format,
 *  - legacy `pbkdf2$…` hashes still verify (migration path),
 *  - needsRehash() flags non-Argon2id hashes for upgrade-on-login,
 *  - 12-char minimum enforced on hash(),
 *  - HIBP k-anonymity screening with graceful offline fallback.
 *
 * The real argon2 native binding is used (fast enough for a handful of
 * vectors). HIBP is stubbed per-test so the suite never touches the network.
 */
describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
    jest.spyOn(service, 'isBreached').mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hashes into the Argon2id PHC format', async () => {
    const hashed = await service.hash('CorrectHorse123!');

    // The argon2 library serializes params in m,p,t order.
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });

  it('verifies the correct password against its Argon2id hash', async () => {
    const hashed = await service.hash('CorrectHorse123!');

    await expect(service.verify('CorrectHorse123!', hashed)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hashed = await service.hash('CorrectHorse123!');

    await expect(service.verify('WrongPassword!!', hashed)).resolves.toBe(false);
  });

  it('uses a random salt: two hashes of the same password differ', async () => {
    const [a, b] = await Promise.all([service.hash('same-password-1'), service.hash('same-password-2x')]);

    expect(a).not.toBe(b);
    await expect(service.verify('same-password-1', a)).resolves.toBe(true);
    await expect(service.verify('same-password-2x', b)).resolves.toBe(true);
  });

  it('still verifies legacy pbkdf2$ hashes (migration path)', async () => {
    // Fixture produced by the pre-migration PasswordService:
    // pbkdf2Sync('LegacyPass123!', salt, 100000, 64, 'sha512').
    const crypto = require('crypto');
    const salt = 'abcdef0123456789abcdef0123456789';
    const hash = crypto.pbkdf2Sync('LegacyPass123!', salt, 100000, 64, 'sha512').toString('hex');
    const legacy = `pbkdf2$100000$${salt}$${hash}`;

    await expect(service.verify('LegacyPass123!', legacy)).resolves.toBe(true);
    await expect(service.verify('WrongPassword!!', legacy)).resolves.toBe(false);
  });

  it('needsRehash() is true for legacy hashes and false for Argon2id', async () => {
    const fresh = await service.hash('SomePassword123');

    expect(service.needsRehash('pbkdf2$100000$salt$hash')).toBe(true);
    expect(service.needsRehash('')).toBe(true);
    expect(service.needsRehash(fresh)).toBe(false);
  });

  it('rehash() produces a verifiable Argon2id hash', async () => {
    const upgraded = await service.rehash('LegacyPass123!');

    expect(upgraded).toMatch(/^\$argon2id\$/);
    await expect(service.verify('LegacyPass123!', upgraded)).resolves.toBe(true);
  });

  it('fail-closed on malformed stored hashes', async () => {
    await expect(service.verify('anything', '')).resolves.toBe(false);
    await expect(service.verify('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(service.verify('anything', 'bcrypt$12$salt$hash')).resolves.toBe(false);
    await expect(service.verify('anything', 'pbkdf2$100000$onlytwoparts')).resolves.toBe(false);
    await expect(service.verify('anything', '$argon2id$garbage')).resolves.toBe(false);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    await expect(service.hash('Short1!')).rejects.toThrow(BadRequestException);
    await expect(service.hash('Exactly11ch')).rejects.toThrow(BadRequestException);
    await expect(service.hash('Exactly12char')).resolves.toMatch(/^\$argon2id\$/);
  });

  it('rejects breached passwords reported by HIBP', async () => {
    (service.isBreached as jest.Mock).mockResolvedValue(true);

    await expect(service.hash('SomeLongPassword123!')).rejects.toThrow(
      /appeared in known data breaches/i,
    );
  });

  describe('isBreached (HIBP k-anonymity)', () => {
    const realFetch = global.fetch;

    afterEach(() => {
      global.fetch = realFetch;
    });

    it('detects a breached password from the suffix list', async () => {
      const crypto = require('crypto');
      const sha1 = crypto.createHash('sha1').update('P@ssw0rdBreached1', 'utf8').digest('hex').toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);

      const unmocked = jest.requireActual('./password.service').PasswordService;
      const svc = new unmocked();
      global.fetch = jest.fn().mockImplementation((url: string) => {
        expect(url).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
        // Only the 5-char prefix leaves the process — assert the full
        // SHA-1 is NOT in the request.
        expect(url).not.toContain(suffix);
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(`AAAAA111111111111111111111111111111:3\n${suffix}:48217\nBBBBB:1`),
        });
      });

      await expect(svc.isBreached('P@ssw0rdBreached1')).resolves.toBe(true);
    });

    it('returns false when the suffix is absent', async () => {
      const unmocked = jest.requireActual('./password.service').PasswordService;
      const svc = new unmocked();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('AAAAA111111111111111111111111111111:3\nBBBBB222222222222222222222222222222:1'),
      });

      await expect(svc.isBreached('DefinitelyNotBreached999!')).resolves.toBe(false);
    });

    it('fails open (false) when the network is down and logs [SECURITY_EVENT]', async () => {
      const unmocked = jest.requireActual('./password.service').PasswordService;
      const svc = new unmocked();
      const warnSpy = jest.spyOn((svc as any).logger, 'warn');
      global.fetch = jest.fn().mockRejectedValue(new Error('DNS failure'));

      await expect(svc.isBreached('AnyPassword123!')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SECURITY_EVENT]'));
    });

    it('fails open (false) on a non-200 HIBP response and logs [SECURITY_EVENT]', async () => {
      const unmocked = jest.requireActual('./password.service').PasswordService;
      const svc = new unmocked();
      const warnSpy = jest.spyOn((svc as any).logger, 'warn');
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

      await expect(svc.isBreached('AnyPassword123!')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SECURITY_EVENT]'));
    });
  });
});
