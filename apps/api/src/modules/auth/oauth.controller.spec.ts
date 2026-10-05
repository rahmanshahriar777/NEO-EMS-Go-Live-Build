/**
 * OAuthController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { setAuthCookies } from '../../common/cookies/auth-cookies';

// Same ESM-only chains as the MFA controller spec: mock them.
jest.mock('../../common/cookies/auth-cookies', () => ({
  setAuthCookies: jest.fn(),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

describe('OAuthController', () => {
  let controller: OAuthController;
  let oauthService: any;

  const res: any = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });
  const req: any = (cookie?: string) => ({
    ip: '10.0.0.9',
    socket: {},
    headers: cookie ? { cookie } : {},
  });

  beforeEach(async () => {
    oauthService = { getAuthorizationUrl: jest.fn(), handleCallback: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OAuthController],
      providers: [
        { provide: OAuthService, useValue: oauthService },
        { provide: ConfigService, useValue: { get: jest.fn((k: string, f?: any) => f) } },
      ],
    }).compile();

    controller = module.get<OAuthController>(OAuthController);
  });

  it('authorizationUrl sets the state cookie and returns the IdP URL', async () => {
    oauthService.getAuthorizationUrl.mockReturnValue('https://idp/authorize?x=1');
    const r = res();

    const out = await controller.authorizationUrl('google' as any, r);

    expect(oauthService.getAuthorizationUrl).toHaveBeenCalledWith(
      'google',
      expect.any(String),
    );
    expect(r.cookie).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: '/api' }),
    );
    expect(out).toEqual({ success: true, data: { url: 'https://idp/authorize?x=1' } });
  });

  it('callback surfaces an IdP error without a session', async () => {
    const r = res();
    const out = await controller.callback('google' as any, 'code', 'state', 'access_denied', req(), r);

    expect(out.success).toBe(false);
    expect(out.message).toMatch(/did not complete/);
    expect(oauthService.handleCallback).not.toHaveBeenCalled();
    expect(r.clearCookie).toHaveBeenCalled();
  });

  it('callback returns an MFA challenge when the account needs a second factor', async () => {
    oauthService.handleCallback.mockResolvedValue({
      mfaRequired: true,
      challengeToken: 'ch-1',
    });
    const r = res();

    const out = await controller.callback(
      'google' as any,
      'code',
      'state',
      undefined,
      req('oauth_state=state'),
      r,
    );

    expect(oauthService.handleCallback).toHaveBeenCalledWith(
      'google',
      'code',
      'state',
      'state',
      '10.0.0.9',
    );
    expect(out).toEqual({
      success: true,
      mfaRequired: true,
      challengeToken: 'ch-1',
      message: 'Second factor required. Submit your authenticator code to complete login.',
    });
    expect(setAuthCookies).not.toHaveBeenCalled();
  });

  it('callback sets session cookies on success and never puts tokens in the body', async () => {
    const tokens = { accessToken: 'at', refreshToken: 'rt' };
    oauthService.handleCallback.mockResolvedValue({ user: { id: 'u1' }, tokens });
    const r = res();

    const out = await controller.callback(
      'google' as any,
      'code',
      'state',
      undefined,
      req('oauth_state=state'),
      r,
    );

    expect(setAuthCookies).toHaveBeenCalledWith(r, tokens, expect.anything());
    expect(out.success).toBe(true);
    expect(out.data.user).toEqual({ id: 'u1' });
    expect(JSON.stringify(out)).not.toContain('rt');
  });
});
