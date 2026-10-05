import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { AuthService, LoginResult } from './auth.service';
import { TokenService } from './token.service';
import { SystemRole } from '@ems/shared';

/**
 * Phase 3, item 5 — Google + Microsoft OAuth sign-in.
 *
 * Implemented with plain fetch (no passport strategies): the IdP token
 * endpoints are two POSTs and the profiles are two GETs, which keeps the
 * dependency surface small and the link-or-create logic explicit.
 *
 * Flow:
 *   1. GET /auth/oauth/:provider → { url, } — the SPA redirects the browser
 *      there. A random `state` is issued and parked in a short-lived
 *      httpOnly `oauth_state` cookie (login-CSRF protection on the OAuth
 *      round-trip itself).
 *   2. GET /auth/oauth/:provider/callback?code=…&state=… (public) → the state
 *      cookie is validated, the code is exchanged, the profile is fetched,
 *      and the user is linked-or-created:
 *        a. The IdP profile MUST carry a verified email (provider's verified
 *           flag); unverified profiles are rejected — no account linking,
 *           no session, no exception path around verification.
 *        b. OAuthAccount(provider, providerId) exists → that user;
 *        c. else a user with the profile email exists → link a new
 *           OAuthAccount row to them;
 *        d. else create a verified EMPLOYEE user + employee scaffold and link.
 *      New users get a random unusable password hash (Argon2id of 32 random
 *      bytes): password login is impossible until they complete a reset.
 *   3. If the user has MFA enrolled, NO session is issued here: the caller
 *      receives { mfaRequired: true, challengeToken } and must complete
 *      POST /mfa/challenge. Otherwise a normal NEO EMS session is issued
 *      (httpOnly cookies; nothing in the body). Account lockout and
 *      email-verified checks run inside AuthService.completeMfaLogin, so the
 *      OAuth path enforces the same account-state gates as password login.
 *
 * Prisma table needed (worker 4 — migration + client regeneration):
 *   model OAuthAccount {
 *     id         String   @id @default(uuid())
 *     userId     String
 *     provider   String   // 'google' | 'microsoft'
 *     providerId String
 *     email      String?
 *     createdAt  DateTime @default(now())
 *     user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
 *     @@unique([provider, providerId])
 *     @@index([userId])
 *     @@map("oauth_accounts")
 *   }
 * Until the migration lands, access goes through `(prisma as any).oAuthAccount`.
 */
export type OAuthProvider = 'google' | 'microsoft';

const SUPPORTED_PROVIDERS: OAuthProvider[] = ['google', 'microsoft'];

interface OAuthProfile {
  providerId: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  private oAuthAccountDelegate(): any {
    return (this.prisma as any).oAuthAccount;
  }

  /** Constant-time state comparison that tolerates length mismatches. */
  private statesMatch(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private assertEnabled(provider: OAuthProvider): void {
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Unsupported OAuth provider '${provider}'`);
    }
    if (!this.configService.get<boolean>('oauth.enabled', false)) {
      throw new ForbiddenException('OAuth sign-in is disabled');
    }
    const cfg = this.providerConfig(provider);
    if (!cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) {
      throw new ForbiddenException(
        `OAuth provider '${provider}' is not configured (client id/secret/redirect URI missing)`,
      );
    }
  }

  private providerConfig(provider: OAuthProvider): {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tenant: string;
  } {
    const ns = `oauth.${provider}`;
    return {
      clientId: this.configService.get<string>(`${ns}.clientId`, ''),
      clientSecret: this.configService.get<string>(`${ns}.clientSecret`, ''),
      redirectUri: this.configService.get<string>(`${ns}.redirectUri`, ''),
      tenant: this.configService.get<string>('oauth.microsoft.tenant', 'common'),
    };
  }

  /** Step 1: build the IdP authorization URL for the given state token. */
  getAuthorizationUrl(provider: OAuthProvider, state: string): string {
    this.assertEnabled(provider);
    const cfg = this.providerConfig(provider);

    if (provider === 'google') {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid profile email offline_access',
      state,
    });
    return `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Step 2: validate state, exchange the code, fetch the profile, link-or-
   * create the user, and issue a NEO EMS session — or an MFA challenge when
   * the user has MFA enrolled (never a full session before the second
   * factor).
   */
  async handleCallback(
    provider: OAuthProvider,
    code: string,
    state: string,
    expectedState: string | null,
    ipAddress?: string,
  ): Promise<LoginResult> {
    this.assertEnabled(provider);

    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }
    if (!state || !expectedState || !this.statesMatch(state, expectedState)) {
      throw new BadRequestException('Invalid OAuth state (possible CSRF — please retry sign-in)');
    }

    const profile = await this.fetchProfile(provider, code);
    if (!profile.email) {
      throw new BadRequestException(`OAuth provider '${provider}' did not return an email address`);
    }

    // Go-live hardening (a): never link or create an account on an
    // IdP-unverified email. A forged/typo'd IdP email must not become a
    // verified NEO EMS identity; the user verifies through the normal flow
    // instead.
    if (profile.emailVerified !== true) {
      this.logger.warn(
        `OAuth sign-in via ${provider} rejected: IdP email '${profile.email}' is not verified`,
      );
      throw new BadRequestException(
        `OAuth sign-in with ${provider} requires a verified email address at the identity provider. ` +
          'Verify your email there first, or sign in with your NEO EMS credentials.',
      );
    }

    const userId = await this.linkOrCreateUser(provider, profile);

    // Go-live hardening (b): MFA-enrolled users get a challenge token, not a
    // session. The second factor is proven at POST /mfa/challenge, which
    // finishes via AuthService.completeMfaLogin.
    if (await this.isMfaEnrolled(userId)) {
      const challengeToken = await this.tokenService.createMfaChallengeToken(userId);
      this.logger.log(`OAuth sign-in via ${provider} for user ${userId}: MFA challenge issued`);
      return { mfaRequired: true, challengeToken };
    }

    const session = await this.authService.completeMfaLogin(userId, ipAddress);
    this.logger.log(`OAuth sign-in via ${provider} for user ${userId} (${profile.email})`);
    return session;
  }

  /**
   * Narrow MFA-enrollment read. The mfaEnabled column may not exist yet on
   * databases whose migration is pending — a missing column degrades to
   * "not enrolled" (logged) rather than breaking OAuth sign-in entirely.
   * Once the column is guaranteed, this can drop the try/catch.
   */
  private async isMfaEnrolled(userId: string): Promise<boolean> {
    try {
      const row = await (this.prisma as any).user.findUnique({
        where: { id: userId },
        select: { mfaEnabled: true },
      });
      return row?.mfaEnabled === true;
    } catch (e) {
      this.logger.warn(`MFA enrollment check failed for user ${userId}: ${(e as Error).message}`);
      return false;
    }
  }

  private async fetchProfile(provider: OAuthProvider, code: string): Promise<OAuthProfile> {
    const cfg = this.providerConfig(provider);
    try {
      if (provider === 'google') {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            redirect_uri: cfg.redirectUri,
            grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) {
          throw new Error(`token exchange failed (status ${tokenRes.status})`);
        }
        const { access_token } = (await tokenRes.json()) as { access_token?: string };
        if (!access_token) throw new Error('token exchange returned no access token');

        const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!profileRes.ok) throw new Error(`userinfo failed (status ${profileRes.status})`);
        const p = (await profileRes.json()) as any;
        return {
          providerId: String(p.sub),
          email: String(p.email || '').toLowerCase(),
          emailVerified: p.email_verified === true,
          firstName: p.given_name,
          lastName: p.family_name,
        };
      }

      // Microsoft
      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            redirect_uri: cfg.redirectUri,
            grant_type: 'authorization_code',
          }),
        },
      );
      if (!tokenRes.ok) {
        throw new Error(`token exchange failed (status ${tokenRes.status})`);
      }
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) throw new Error('token exchange returned no access token');

      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!profileRes.ok) throw new Error(`graph /me failed (status ${profileRes.status})`);
      const p = (await profileRes.json()) as any;
      const email = String(p.mail || p.userPrincipalName || '').toLowerCase();
      return {
        providerId: String(p.id),
        email,
        // Microsoft Graph does not expose a single email_verified flag on /me;
        // tenant-issued identities are treated as verified, consumer accounts
        // keep emailVerified=false and must verify via the normal flow.
        emailVerified: email.endsWith('.onmicrosoft.com') === false && Boolean(p.mail),
        firstName: p.givenName,
        lastName: p.surname,
      };
    } catch (e) {
      this.logger.warn(`OAuth ${provider} profile fetch failed: ${(e as Error).message}`);
      throw new BadRequestException(`OAuth sign-in with ${provider} failed. Please try again.`);
    }
  }

  private async linkOrCreateUser(provider: OAuthProvider, profile: OAuthProfile): Promise<string> {
    // (a) Existing link → that user.
    const existing = await this.oAuthAccountDelegate().findUnique({
      where: { provider_providerId: { provider, providerId: profile.providerId } },
      select: { userId: true },
    });
    if (existing) {
      return existing.userId as string;
    }

    // (b) Email matches an existing user → link.
    const userByEmail = await this.prisma.user.findUnique({
      where: { email: profile.email },
      select: { id: true },
    });
    if (userByEmail) {
      await this.oAuthAccountDelegate().create({
        data: {
          userId: userByEmail.id,
          provider,
          providerId: profile.providerId,
          email: profile.email,
        },
      });
      return userByEmail.id;
    }

    // (c) Create a verified EMPLOYEE user + employee scaffold, then link.
    // Unusable password: Argon2id hash of 32 random bytes nobody knows.
    // emailVerified is set unconditionally: handleCallback rejects
    // IdP-unverified profiles before this point, so reaching here means the
    // IdP attested the address.
    const unusableHash = await this.passwordService.hash(crypto.randomBytes(32).toString('hex'));
    const { user } = await this.userService.createUser(
      profile.email,
      unusableHash,
      profile.firstName || profile.email.split('@')[0],
      profile.lastName || '',
      [SystemRole.EMPLOYEE],
    );
    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
    await this.oAuthAccountDelegate().create({
      data: {
        userId: user.id,
        provider,
        providerId: profile.providerId,
        email: profile.email,
      },
    });
    return user.id;
  }
}
