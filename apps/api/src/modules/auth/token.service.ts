import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import { parseDurationMs } from '../../config/configuration';
import { JwtPayload, TokensResponse, SystemRole } from '@ems/shared';
import * as crypto from 'crypto';

/**
 * Purpose claim for the short-lived MFA challenge token issued when a user
 * with MFA enabled passes the password check but has not yet supplied the
 * second factor. Distinct from access/refresh tokens; never authorizes API
 * access on its own.
 */
const MFA_CHALLENGE_PURPOSE = 'mfa-challenge';
const MFA_CHALLENGE_TTL = '5m';

/**
 * P0-7a — single-use MFA challenges. Consumed challenge jtis live in Redis
 * with a TTL comfortably beyond the 5-minute challenge lifetime; a replayed
 * (challenge, code) pair is rejected even though the JWT itself still
 * verifies.
 */
const MFA_CHALLENGE_CONSUMED_PREFIX = 'mfa:challenge:consumed:';
const MFA_CHALLENGE_CONSUMED_TTL_S = 10 * 60;

/** P0-7b — consumed TOTP 30s time-steps, one key per (user, step). */
const MFA_TOTP_USED_PREFIX = 'mfa:totp:used:';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** Refresh-token lifetime in ms, honoring the REFRESH_TTL config (item 7). */
  private refreshTtlMs(): number {
    return this.configService.get<number>('jwt.refreshTtlMs', 7 * 24 * 60 * 60 * 1000);
  }

  async generateTokens(
    userId: string,
    email: string,
    roles: SystemRole[],
    permissions: string[],
    employeeId?: string,
    existingFamilyId?: string,
    ipAddress?: string,
  ): Promise<TokensResponse> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      roles,
      permissions,
      employeeId,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.accessSecret'),
      // Seconds as a number; duration string validated at startup.
      expiresIn: Math.floor(
        parseDurationMs(this.configService.get<string>('jwt.accessExpiration', '15m'), 'jwt.accessExpiration') / 1000,
      ),
    });

    const rawRefreshToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);
    const familyId = existingFamilyId || crypto.randomUUID();

    // Item 7: honor REFRESH_TTL config instead of a hardcoded 7 days.
    const expiresAt = new Date(Date.now() + this.refreshTtlMs());

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        familyId,
        expiresAt,
        createdIp: ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken: `${familyId}.${rawRefreshToken}`,
      tokenType: 'Bearer',
      expiresIn: 15 * 60, // 15 minutes in seconds
    };
  }

  /**
   * Item 7 — hardened rotation.
   *
   * - The old token is revoked with a SINGLE conditional UPDATE
   *   (`isRevoked: false` in the WHERE clause): an atomic compare-and-set.
   *   If two requests race the same token, exactly one wins; the loser sees
   *   count === 0 and is treated as reuse.
   * - The family id comes from the STORED record (`storedToken.familyId`),
   *   never from the client-supplied `familyId` prefix — a client cannot
   *   smuggle a foreign family id into reuse detection or the new token.
   * - Reuse of a revoked token burns the entire stored family.
   */
  async rotateRefreshToken(refreshTokenString: string, ipAddress?: string): Promise<TokensResponse> {
    const parts = refreshTokenString.split('.');
    if (parts.length !== 2) {
      throw new UnauthorizedException('Invalid refresh token format');
    }

    const rawToken = parts[1];
    const tokenHash = this.hashToken(rawToken);

    const storedToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            employee: true,
          },
        },
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Reuse detection: a revoked token presented again means the token was
    // likely stolen. Burn the whole STORED family (not the client prefix).
    if (storedToken.isRevoked) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('Compromised refresh token reused. All active sessions invalidated.');
    }

    if (new Date() > storedToken.expiresAt) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Atomic compare-and-set: revoke only if still unrevoked. A concurrent
    // rotation of the same token yields count 0 → treat as reuse.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { id: storedToken.id, isRevoked: false },
      data: { isRevoked: true },
    });

    if (revoked.count === 0) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: storedToken.familyId },
        data: { isRevoked: true },
      });
      throw new UnauthorizedException('Compromised refresh token reused. All active sessions invalidated.');
    }

    // Extract user roles and permissions
    const roles: SystemRole[] = storedToken.user.roles.map((r) => r.role.name as SystemRole);
    const permissionsSet = new Set<string>();
    for (const ur of storedToken.user.roles) {
      for (const rp of ur.role.permissions) {
        permissionsSet.add(`${rp.permission.subject}:${rp.permission.action}`);
      }
    }

    return this.generateTokens(
      storedToken.userId,
      storedToken.user.email,
      roles,
      Array.from(permissionsSet),
      storedToken.user.employee?.id,
      storedToken.familyId,
      ipAddress,
    );
  }

  async revokeToken(refreshTokenString: string): Promise<void> {
    const parts = refreshTokenString.split('.');
    if (parts.length === 2) {
      const tokenHash = this.hashToken(parts[1]);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash },
        data: { isRevoked: true },
      });
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId },
      data: { isRevoked: true },
    });
  }

  /** Revoke a single session (refresh-token family). Used by the MFA sessions page. */
  async revokeTokenFamily(userId: string, familyId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, isRevoked: false },
      data: { isRevoked: true },
    });
    return result.count;
  }

  /**
   * List active sessions: one row per refresh-token family with the newest
   * unrevoked token's metadata. Backs the MFA "active sessions" page.
   */
  async listActiveSessions(userId: string): Promise<
    Array<{
      familyId: string;
      createdAt: Date;
      createdIp: string | null;
      expiresAt: Date;
    }>
  > {
    const tokens = await this.prisma.refreshToken.findMany({
      where: { userId, isRevoked: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { familyId: true, createdAt: true, createdIp: true, expiresAt: true },
    });
    const byFamily = new Map<string, (typeof tokens)[number]>();
    for (const t of tokens) {
      if (!byFamily.has(t.familyId)) {
        byFamily.set(t.familyId, t);
      }
    }
    return Array.from(byFamily.values());
  }

  /**
   * Issue a short-lived MFA challenge token after a successful password check
   * for a user with MFA enabled. The client presents it to POST /mfa/challenge
   * together with the TOTP code (or a recovery code) to complete login.
   *
   * P0-7a: carries a random `jti` so each challenge is single-use — the jti
   * is recorded in Redis on first successful completion and reuse is
   * rejected (see consumeMfaChallengeToken).
   */
  async createMfaChallengeToken(userId: string): Promise<string> {
    return this.jwtService.sign(
      { sub: userId, purpose: MFA_CHALLENGE_PURPOSE, jti: crypto.randomUUID() },
      {
        secret: this.configService.get<string>('jwt.accessSecret'),
        expiresIn: MFA_CHALLENGE_TTL,
      },
    );
  }

  /**
   * Validate a challenge token (signature, purpose, jti present) and return
   * the user id plus the jti. Does NOT consume the challenge — consumption
   * happens in consumeMfaChallengeToken after the second factor verifies, so
   * a wrong TOTP code does not burn the challenge.
   */
  async verifyMfaChallengeToken(challengeToken: string): Promise<{ userId: string; jti: string }> {
    try {
      const payload = this.jwtService.verify<{ sub: string; purpose: string; jti?: string }>(
        challengeToken,
        {
          secret: this.configService.get<string>('jwt.accessSecret'),
        },
      );
      if (!payload?.sub || !payload?.jti || payload.purpose !== MFA_CHALLENGE_PURPOSE) {
        throw new UnauthorizedException('Invalid MFA challenge token');
      }
      return { userId: payload.sub, jti: payload.jti };
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('Invalid or expired MFA challenge token');
    }
  }

  /**
   * P0-7a — consume an MFA challenge exactly once.
   *
   * Atomically claims the challenge jti in Redis (SET NX). The first
   * completion wins; any replay of the same challenge token — even with a
   * fresh TOTP code — is rejected, so a captured (challenge, code) pair can
   * never mint a second session.
   */
  async consumeMfaChallengeToken(jti: string): Promise<void> {
    if (!this.replayStoreAvailable('MFA challenge single-use check')) {
      return;
    }
    const claimed = await this.redisService.setIfAbsent(
      `${MFA_CHALLENGE_CONSUMED_PREFIX}${jti}`,
      '1',
      MFA_CHALLENGE_CONSUMED_TTL_S,
    );
    if (!claimed) {
      this.logger.warn(`Rejected replay of consumed MFA challenge jti=${jti}`);
      throw new UnauthorizedException('MFA challenge token has already been used');
    }
  }

  /**
   * P0-7b — claim one TOTP 30s time-step for a user.
   *
   * Returns true when this caller consumed the step (first use), false when
   * the step was already consumed (replay within the epoch window). Atomic
   * via Redis SET NX: two concurrent requests with the same code cannot both
   * win. TTL covers the step's whole acceptance horizon; callers pass
   * (window + 2) * 30 seconds.
   */
  async claimTotpTimeStep(userId: string, timeStep: number, ttlSeconds: number): Promise<boolean> {
    if (!this.replayStoreAvailable('TOTP replay check')) {
      return true;
    }
    const claimed = await this.redisService.setIfAbsent(
      `${MFA_TOTP_USED_PREFIX}${userId}:${timeStep}`,
      '1',
      ttlSeconds,
    );
    if (!claimed) {
      this.logger.warn(`Rejected replayed TOTP code for user ${userId} (timeStep=${timeStep})`);
    }
    return claimed;
  }

  /**
   * Replay guards are Redis-backed. When Redis is unreachable we fail open
   * (allow the request) with a loud warning — the same convention as the
   * Redis throttler storage — rather than bricking all MFA logins during a
   * Redis outage. Redis disconnects should be alerted on in production.
   */
  private replayStoreAvailable(what: string): boolean {
    if (this.redisService.getIsConnected()) {
      return true;
    }
    this.logger.warn(`${what} degraded: Redis unavailable (fail-open)`);
    return false;
  }
}
