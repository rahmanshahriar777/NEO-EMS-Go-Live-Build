import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../core/prisma/prisma.service';
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

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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
   */
  async createMfaChallengeToken(userId: string): Promise<string> {
    return this.jwtService.sign(
      { sub: userId, purpose: MFA_CHALLENGE_PURPOSE },
      {
        secret: this.configService.get<string>('jwt.accessSecret'),
        expiresIn: MFA_CHALLENGE_TTL,
      },
    );
  }

  /** Validate a challenge token and return the user id it was issued for. */
  async verifyMfaChallengeToken(challengeToken: string): Promise<string> {
    try {
      const payload = this.jwtService.verify<{ sub: string; purpose: string }>(challengeToken, {
        secret: this.configService.get<string>('jwt.accessSecret'),
      });
      if (!payload?.sub || payload.purpose !== MFA_CHALLENGE_PURPOSE) {
        throw new UnauthorizedException('Invalid MFA challenge token');
      }
      return payload.sub;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      throw new UnauthorizedException('Invalid or expired MFA challenge token');
    }
  }
}
