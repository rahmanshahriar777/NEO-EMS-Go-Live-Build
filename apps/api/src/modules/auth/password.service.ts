import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

/**
 * Phase 1 hardening — password hashing migrated to Argon2id.
 *
 * - New hashes: Argon2id (OWASP cheat-sheet parameters: 19 MiB memory,
 *   2 iterations, 1 lane), encoded in the standard PHC string format
 *   (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`).
 * - Legacy hashes (`pbkdf2$<iterations>$<salt>$<hash>`, written by the old
 *   PasswordService and by the dev seed) still VERIFY, so existing users are
 *   never locked out. On the next successful login AuthService re-hashes with
 *   Argon2id (see `needsRehash`).
 * - 12-character minimum enforced on every set (register, invitation accept,
 *   password change/reset).
 * - Breached-password screening via HIBP k-anonymity: only the first 5 hex
 *   chars of the SHA-1 ever leave the process; a network failure skips the
 *   check (graceful offline fallback) rather than blocking the user.
 */
const MIN_PASSWORD_LENGTH = 12;

// OWASP Password Storage Cheat Sheet — Argon2id first-choice parameters.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// Legacy PBKDF2 parameters (verify-only path for pre-migration hashes).
const LEGACY_PBKDF2_KEY_LENGTH = 64;
const LEGACY_PBKDF2_DIGEST = 'sha512';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 5_000;
const HIBP_USER_AGENT = 'NEO-EMS/1.0 (breached-password screening)';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /** Hash a NEW password. Throws when the password violates policy. */
  async hash(password: string): Promise<string> {
    await this.assertPasswordAcceptable(password);
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verify against either a current Argon2id hash or a legacy PBKDF2 hash.
   * Fail-closed: unknown formats and empty inputs return false, never throw.
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    if (!password || !storedHash) return false;

    if (storedHash.startsWith('$argon2id$')) {
      try {
        return await argon2.verify(storedHash, password);
      } catch {
        return false;
      }
    }

    if (storedHash.startsWith('pbkdf2$')) {
      return this.verifyLegacyPbkdf2(password, storedHash);
    }

    // Unknown scheme (e.g. bcrypt from a foreign import): do not attempt.
    return false;
  }

  /**
   * True when the stored hash is NOT a current Argon2id hash and should be
   * upgraded on the next successful login. Called by AuthService AFTER a
   * successful verify, never on failure (no oracle for attackers).
   */
  needsRehash(storedHash: string): boolean {
    return !storedHash?.startsWith('$argon2id$');
  }

  /** Re-hash the just-verified password with Argon2id. */
  async rehash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /** Policy gate used by every password-setting flow. */
  async assertPasswordAcceptable(password: string): Promise<void> {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      );
    }
    if (await this.isBreached(password)) {
      throw new BadRequestException(
        'This password has appeared in known data breaches. Please choose a different password.',
      );
    }
  }

  /**
   * HIBP k-anonymity check: SHA-1 the password, send only the first 5 hex
   * characters, and compare the remainder locally against the returned
   * suffix list. Returns false (not breached) on ANY transport failure —
   * screening is best-effort and must never block legitimate password sets
   * when offline.
   */
  async isBreached(password: string): Promise<boolean> {
    try {
      const sha1 = crypto
        .createHash('sha1')
        .update(password, 'utf8')
        .digest('hex')
        .toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
      try {
        const res = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
          headers: { 'User-Agent': HIBP_USER_AGENT },
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`HIBP range request failed with status ${res.status}; skipping breach check.`);
          return false;
        }
        const body = await res.text();
        // Each line: '<suffix>:<count>'. Compare the full suffix locally.
        for (const line of body.split('\n')) {
          const [candidate] = line.trim().split(':');
          if (candidate && candidate.toUpperCase() === suffix) {
            return true;
          }
        }
        return false;
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      // Network/DNS/TLS failure or abort: graceful offline fallback.
      this.logger.warn(`HIBP breach check skipped (offline): ${(e as Error).message}`);
      return false;
    }
  }

  /** Verify-only path for pre-migration `pbkdf2$<iter>$<salt>$<hash>` hashes. */
  private verifyLegacyPbkdf2(password: string, storedHash: string): boolean {
    try {
      const parts = storedHash.split('$');
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
        return false;
      }
      const iterations = parseInt(parts[1], 10);
      if (!Number.isFinite(iterations) || iterations <= 0) {
        return false;
      }
      const salt = parts[2];
      const originalHash = parts[3];
      const computedHash = crypto
        .pbkdf2Sync(password, salt, iterations, LEGACY_PBKDF2_KEY_LENGTH, LEGACY_PBKDF2_DIGEST)
        .toString('hex');
      const a = Buffer.from(originalHash, 'hex');
      const b = Buffer.from(computedHash, 'hex');
      if (a.length !== b.length) {
        return false;
      }
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
