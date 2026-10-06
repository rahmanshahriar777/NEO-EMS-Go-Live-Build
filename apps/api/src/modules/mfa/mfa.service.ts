import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as argon2 from 'argon2';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { AuthService } from '../auth/auth.service';

/**
 * Phase 2, item 8 — TOTP multi-factor authentication + active sessions.
 *
 * Flow:
 *   1. POST /mfa/totp/setup → returns { secret, otpauthUrl } (client renders
 *      the QR code). The secret is stored ENCRYPTED with the document keyring
 *      on the user but MFA stays DISABLED.
 *   2. POST /mfa/totp/verify { token } → verifies the TOTP code against the
 *      decrypted secret; on success MFA is ENABLED and 10 one-time recovery
 *      codes are returned (shown ONCE — Argon2id hashes stored at rest).
 *   3. Login for an MFA-enabled user returns { mfaRequired: true,
 *      challengeToken } after the password check; POST /mfa/challenge
 *      { challengeToken, code } completes login with a TOTP code OR an unused
 *      recovery code (recovery codes are single-use: the hash is deleted).
 *   4. POST /mfa/totp/disable { password } → clears secret, hashes and the flag.
 *   5. GET /mfa/status → enrollment state (never the secret).
 */
const RECOVERY_CODE_COUNT = 10;

interface MfaFields {
  mfaSecret: string | null;
  mfaEnabled: boolean;
  mfaRecoveryHashes: string[];
}

function newRecoveryCode(): string {
  // Unambiguous alphabet (no 0/O, 1/I/l): 8 chars ≈ 41 bits of entropy.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) {
    code += alphabet[b % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function hashRecoveryCode(code: string): Promise<string> {
  return argon2.hash(code, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

async function verifyRecoveryCode(candidate: string, hash: string): Promise<boolean> {
  if (hash.startsWith('$argon2id$')) {
    try {
      return await argon2.verify(hash, candidate);
    } catch {
      return false;
    }
  }
  // Backwards compatibility for legacy unsalted SHA-256 hashes
  const sha = crypto.createHash('sha256').update(candidate).digest('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(sha, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
  ) {}

  private userDelegate(): any {
    return (this.prisma as any).user;
  }

  private getMfaKey(keyHex?: string): Buffer | null {
    const hex = keyHex ?? this.configService.get<string>('DOCUMENT_ENCRYPTION_KEY');
    if (!hex) return null;
    try {
      const buf = Buffer.from(hex, 'hex');
      if (buf.length === 32) return buf;
      return crypto.createHash('sha256').update(hex).digest();
    } catch {
      return null;
    }
  }

  private encryptSecret(secret: string): string {
    const key = this.getMfaKey();
    if (!key) return secret;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  private decryptSecret(stored: string | null | undefined): string | null {
    if (!stored) return null;
    if (!stored.startsWith('enc:')) return stored;
    const key = this.getMfaKey();
    if (!key) return stored;
    try {
      const parts = stored.split(':');
      if (parts.length !== 4) return stored;
      const [, ivHex, tagHex, dataHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
      return dec.toString('utf8');
    } catch {
      const prevHex = this.configService.get<string>('DOCUMENT_ENCRYPTION_KEY_PREVIOUS');
      if (prevHex) {
        try {
          const prevKey = this.getMfaKey(prevHex);
          if (prevKey) {
            const [, ivHex, tagHex, dataHex] = stored.split(':');
            const decipher = crypto.createDecipheriv('aes-256-gcm', prevKey, Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
            const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
            return dec.toString('utf8');
          }
        } catch {}
      }
      this.logger.error('Failed to decrypt MFA secret');
      return stored;
    }
  }

  private async getMfaFields(userId: string): Promise<MfaFields> {
    const user = await this.userDelegate().findUnique({
      where: { id: userId },
      select: { mfaSecret: true, mfaEnabled: true, mfaRecoveryHashes: true },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {
      mfaSecret: this.decryptSecret(user.mfaSecret),
      mfaEnabled: user.mfaEnabled ?? false,
      mfaRecoveryHashes: user.mfaRecoveryHashes ?? [],
    };
  }

  /**
   * Step 1: generate a TOTP secret and store it PENDING (mfaEnabled stays
   * false until the user proves possession via verifySetup). Re-running setup
   * replaces the pending secret. Secret is encrypted at rest via the document keyring.
   */
  async setupTotp(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
    const { mfaEnabled } = await this.getMfaFields(userId);
    if (mfaEnabled) {
      throw new BadRequestException('MFA is already enabled. Disable it first to re-enroll.');
    }

    const secret = generateSecret();
    const issuer = this.configService.get<string>('mfa.issuer', 'NEO EMS');
    const otpauthUrl = generateURI({ issuer, label: email, secret });

    await this.userDelegate().update({
      where: { id: userId },
      data: { mfaSecret: this.encryptSecret(secret) },
    });

    return { secret, otpauthUrl };
  }

  /**
   * Step 2: verify the TOTP code, enable MFA, and mint one-time recovery
   * codes. The raw codes are returned exactly once. Hashes are Argon2id.
   */
  async verifySetup(userId: string, token: string): Promise<{ recoveryCodes: string[] }> {
    const { mfaSecret, mfaEnabled } = await this.getMfaFields(userId);
    if (mfaEnabled) {
      throw new BadRequestException('MFA is already enabled');
    }
    if (!mfaSecret) {
      throw new BadRequestException('No pending MFA setup. Call POST /mfa/totp/setup first.');
    }

    const window = this.configService.get<number>('mfa.totpWindow', 1);
    // otplib v13: `window` (30s steps each side) -> epochTolerance (seconds).
    const { valid } = verifySync({ secret: mfaSecret, token, epochTolerance: window * 30 });
    if (!valid) {
      throw new BadRequestException('Invalid TOTP code');
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashedCodes = await Promise.all(recoveryCodes.map(hashRecoveryCode));
    await this.userDelegate().update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaRecoveryHashes: hashedCodes,
      },
    });

    this.logger.log(`MFA enabled for user ${userId}`);
    return { recoveryCodes };
  }

  /** Disable MFA after confirming the user's password. Clears everything. */
  async disableMfa(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const ok = await this.passwordService.verify(password, user.passwordHash);
    if (!ok) {
      throw new BadRequestException('Password does not match');
    }
    await this.userDelegate().update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryHashes: [] },
    });
    this.logger.log(`MFA disabled for user ${userId}`);
  }

  /**
   * Enrollment status for GET /mfa/status. Never exposes the secret itself.
   */
  async getStatus(userId: string): Promise<{
    enabled: boolean;
    hasPendingSetup: boolean;
    recoveryCodesRemaining: number;
  }> {
    const { mfaSecret, mfaEnabled, mfaRecoveryHashes } = await this.getMfaFields(userId);
    return {
      enabled: mfaEnabled,
      hasPendingSetup: !mfaEnabled && mfaSecret !== null,
      recoveryCodesRemaining: mfaRecoveryHashes.length,
    };
  }

  /**
   * Complete an MFA login: validate the challenge token, then accept either
   * a TOTP code or an unused recovery code (single-use: its hash is deleted).
   * Returns the full session (user profile + tokens); the controller sets the
   * cookies and returns only the user in the body (item 8).
   *
   * P0-7 replay hardening:
   *  (a) the challenge token is single-use — its jti is consumed in Redis
   *      AFTER the second factor verifies (a wrong code must not burn the
   *      challenge), so a captured (challenge, code) pair cannot mint a
   *      second session;
   *  (b) each TOTP 30s time-step may be consumed only once per user — a
   *      replayed code within its epoch window is rejected.
   */
  async completeChallenge(
    challengeToken: string,
    code: string,
    ipAddress?: string,
  ): Promise<{ user: import('@ems/shared').AuthUserResponse; tokens: import('@ems/shared').TokensResponse }> {
    const { userId, jti } = await this.tokenService.verifyMfaChallengeToken(challengeToken);
    const { mfaSecret, mfaEnabled, mfaRecoveryHashes } = await this.getMfaFields(userId);

    if (!mfaEnabled || !mfaSecret) {
      throw new BadRequestException('MFA is not enabled for this account');
    }

    const window = this.configService.get<number>('mfa.totpWindow', 1);
    const verifyResult = verifySync({ secret: mfaSecret, token: code, epochTolerance: window * 30 });
    const totpOk = verifyResult.valid;
    // otplib 13.5.0 returns the matched 30s time-step at runtime (`timeStep`;
    // verified empirically) but omits it from the public VerifyResult type,
    // hence the narrow cast. It is deterministic per code — unlike
    // floor(now/30)+delta, it cannot straddle a step boundary between verify
    // and claim, which would let a replay slip through.
    const timeStep = (verifyResult as { timeStep?: number }).timeStep ?? null;

    if (totpOk) {
      // P0-7b: claim the code's time-step before minting the session. A
      // replayed code maps to the same step and loses the atomic claim.
      const stepTtlSeconds = (window + 2) * 30;
      const claimed =
        timeStep === null ||
        (await this.tokenService.claimTotpTimeStep(userId, timeStep, stepTtlSeconds));
      if (!claimed) {
        throw new UnauthorizedException('MFA code has already been used');
      }
    } else {
      // Recovery codes are single-use. Verify against stored hashes
      // (supporting Argon2id and legacy sha256), then consume atomically (see consumeRecoveryCode) so
      // two concurrent requests can never double-spend the same code.
      const candidateCode = code.replace(/\s/g, '');
      const consumed = await this.consumeRecoveryCode(userId, mfaRecoveryHashes, candidateCode);
      if (!consumed) {
        throw new UnauthorizedException('Invalid MFA code');
      }
      const remaining = (await this.getMfaFields(userId)).mfaRecoveryHashes.length;
      this.logger.warn(
        `Recovery code consumed for user ${userId} (${remaining} remaining)`,
      );
    }

    // P0-7a: single-use challenge — consumed only after the second factor
    // verified, so a replayed challenge token is rejected here.
    await this.tokenService.consumeMfaChallengeToken(jti);

    return this.authService.completeMfaLogin(userId, ipAddress);
  }

  /**
   * Consume one recovery code atomically.
   *
   * The write is a CONDITIONAL updateMany: it lands only when the
   * stored array is byte-identical to what we read (count === 1 wins).
   * A lost race re-reads once and retries: if the code is gone the caller
   * gets 'Invalid MFA code'; if a *different* code was consumed concurrently,
   * ours is still present and the retry claims it without clobbering.
   */
  private async consumeRecoveryCode(
    userId: string,
    knownHashes: string[],
    candidateCode: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hashes =
        attempt === 0 ? knownHashes : (await this.getMfaFields(userId)).mfaRecoveryHashes;
      let matchIndex = -1;
      for (let i = 0; i < hashes.length; i++) {
        if (await verifyRecoveryCode(candidateCode, hashes[i])) {
          matchIndex = i;
          break;
        }
      }
      if (matchIndex === -1) {
        return false;
      }
      const remaining = hashes.filter((_, i) => i !== matchIndex);
      const claimed = await this.userDelegate().updateMany({
        where: { id: userId, mfaRecoveryHashes: { equals: hashes } },
        data: { mfaRecoveryHashes: remaining },
      });
      if (claimed.count === 1) {
        return true;
      }
      // Lost the race to a concurrent consumer — re-read and retry once.
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Active sessions (Phase 2, item 8 — "active-sessions page backend").
  // Backed by the existing refresh_tokens table (familyId grouping).
  // ------------------------------------------------------------------

  async listSessions(userId: string) {
    const sessions = await this.tokenService.listActiveSessions(userId);
    return sessions.map((s) => ({
      id: s.familyId,
      familyId: s.familyId,
      createdAt: s.createdAt,
      ipAddress: s.createdIp,
      createdIp: s.createdIp,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    const count = await this.tokenService.revokeTokenFamily(userId, familyId);
    if (count === 0) {
      throw new BadRequestException('Session not found or already revoked');
    }
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.tokenService.revokeAllUserTokens(userId);
  }
}
