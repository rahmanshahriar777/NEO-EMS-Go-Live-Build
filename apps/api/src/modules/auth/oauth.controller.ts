import { Controller, Get, Param, Query, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { OAuthService, OAuthProvider } from './oauth.service';
import { Public } from '../../common/decorators/public.decorator';
import { setAuthCookies } from '../../common/cookies/auth-cookies';

/**
 * Phase 3, item 5 — OAuth sign-in endpoints.
 *
 * The `state` round-trip is protected by a short-lived httpOnly
 * `oauth_state` cookie (login-CSRF protection): the callback rejects when the
 * query state does not match the cookie.
 */
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

@ApiTags('Authentication')
@Controller('auth/oauth')
export class OAuthController {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly configService: ConfigService,
  ) {}

  private stateCookieFlags() {
    const isProduction = this.configService.get<string>('nodeEnv') === 'production';
    return { httpOnly: true, secure: isProduction, sameSite: 'lax' as const };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':provider')
  @ApiOperation({ summary: 'Get the IdP authorization URL to redirect the user to' })
  async authorizationUrl(
    @Param('provider') provider: OAuthProvider,
    @Res({ passthrough: true }) res: Response,
  ) {
    const state = crypto.randomBytes(16).toString('hex');
    const url = this.oauthService.getAuthorizationUrl(provider, state);
    res.cookie(OAUTH_STATE_COOKIE, state, {
      ...this.stateCookieFlags(),
      maxAge: OAUTH_STATE_TTL_MS,
      path: '/api',
    });
    return { success: true, data: { url } };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':provider/callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OAuth callback: exchange the code, link-or-create the user, start a session' })
  async callback(
    @Param('provider') provider: OAuthProvider,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (error) {
      // The IdP (or the user) refused: surface it plainly, no session.
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api' });
      return {
        success: false,
        message: `OAuth sign-in with ${provider} did not complete (${error}).`,
      };
    }

    const expectedState = this.readCookie(req, OAUTH_STATE_COOKIE);
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api' });

    const ip = req.ip || req.socket.remoteAddress;
    const result = await this.oauthService.handleCallback(provider, code, state, expectedState, ip);

    // Go-live hardening: MFA-enrolled users complete the second factor at
    // POST /mfa/challenge — no session is issued here.
    if ('mfaRequired' in result) {
      return {
        success: true,
        mfaRequired: true,
        challengeToken: result.challengeToken,
        message: 'Second factor required. Submit your authenticator code to complete login.',
      };
    }

    // Item 8: session tokens travel in httpOnly cookies only, never the body.
    setAuthCookies(res, result.tokens, this.configService);
    return {
      success: true,
      message: 'Logged in successfully',
      data: { user: result.user },
    };
  }

  private readCookie(req: Request, name: string): string | null {
    const header: string | undefined = req.headers?.cookie;
    if (!header) return null;
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? decodeURIComponent(match[1]) : null;
  }
}
