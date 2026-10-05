import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OAuthService } from './oauth.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuthService } from './auth.service';

/**
 * OAuthService tests (Phase 3, item 5): authorization URLs, state validation,
 * code exchange, and the link-or-create ladder. The OAuthAccount table is
 * provided by worker 4's migration; mocked here via
 * `(prisma as any).oAuthAccount`. IdP HTTP is stubbed at global.fetch.
 */
describe('OAuthService', () => {
  let service: OAuthService;
  let prisma: any;
  let userService: { createUser: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let authService: { completeMfaLogin: jest.Mock };
  let tokenService: { createMfaChallengeToken: jest.Mock };
  let configGet: jest.Mock;
  const realFetch = global.fetch;

  const googleProfile = {
    sub: 'google-123',
    email: 'jane@ems.local',
    email_verified: true,
    given_name: 'Jane',
    family_name: 'Smith',
  };

  function mockGoogleFetch() {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'idp-at' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(googleProfile) });
  }

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      oAuthAccount: {
        findUnique: jest.fn(),
        create: jest.fn((args: any) => Promise.resolve({ id: 'oa-1', ...args.data })),
      },
    };
    userService = {
      createUser: jest.fn().mockResolvedValue({ user: { id: 'u-new' }, employee: { id: 'e-new' } }),
    };
    passwordService = { hash: jest.fn().mockResolvedValue('argon2-hash') };
    tokenService = {
      createMfaChallengeToken: jest.fn().mockResolvedValue('challenge-abc'),
    };
    authService = {
      completeMfaLogin: jest.fn().mockResolvedValue({
        user: { id: 'u-x', email: 'jane@ems.local' },
        tokens: { accessToken: 'at', refreshToken: 'rt' },
      }),
    };
    configGet = jest.fn((key: string, fallback?: any) => {
      const map: Record<string, any> = {
        'oauth.enabled': true,
        'oauth.google.clientId': 'google-id',
        'oauth.google.clientSecret': 'google-secret',
        'oauth.google.redirectUri': 'https://api/cb',
        'oauth.microsoft.clientId': '',
        'oauth.microsoft.clientSecret': '',
        'oauth.microsoft.redirectUri': '',
        'oauth.microsoft.tenant': 'common',
      };
      return key in map ? map[key] : fallback;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    service = module.get<OAuthService>(OAuthService);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('getAuthorizationUrl', () => {
    it('builds the Google authorization URL with the state token', () => {
      const url = service.getAuthorizationUrl('google', 'state-123');

      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=google-id');
      expect(url).toContain('state=state-123');
      expect(url).toContain('scope=openid');
    });

    it('builds the Microsoft authorization URL', () => {
      configGet.mockImplementation((key: string, fallback?: any) => {
        const map: Record<string, any> = {
          'oauth.enabled': true,
          'oauth.microsoft.clientId': 'ms-id',
          'oauth.microsoft.clientSecret': 'ms-secret',
          'oauth.microsoft.redirectUri': 'https://api/ms-cb',
          'oauth.microsoft.tenant': 'tenant-1',
        };
        return key in map ? map[key] : fallback;
      });

      const url = service.getAuthorizationUrl('microsoft', 's');

      expect(url).toContain('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize');
      expect(url).toContain('client_id=ms-id');
    });

    it('refuses when OAuth is disabled', () => {
      configGet.mockImplementation(() => false);

      expect(() => service.getAuthorizationUrl('google', 's')).toThrow(ForbiddenException);
    });

    it('refuses unsupported providers', () => {
      expect(() => service.getAuthorizationUrl('github' as any, 's')).toThrow(BadRequestException);
    });

    it('refuses when the provider is not configured', () => {
      configGet.mockImplementation((key: string, fallback?: any) =>
        key === 'oauth.enabled' ? true : fallback,
      );

      expect(() => service.getAuthorizationUrl('google', 's')).toThrow(ForbiddenException);
    });
  });

  describe('handleCallback', () => {
    it('rejects a mismatched state (login-CSRF protection)', async () => {
      // State is checked before any IdP HTTP — prove no network call happens.
      global.fetch = jest.fn();
      await expect(
        service.handleCallback('google', 'code', 'attacker-state', 'real-state'),
      ).rejects.toThrow(/state/i);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('links an existing OAuthAccount to its user', async () => {
      mockGoogleFetch();
      prisma.oAuthAccount.findUnique.mockResolvedValue({ userId: 'u-linked' });

      const result = await service.handleCallback('google', 'code', 's', 's', '10.0.0.1');

      expect(prisma.oAuthAccount.findUnique).toHaveBeenCalledWith({
        where: { provider_providerId: { provider: 'google', providerId: 'google-123' } },
        select: { userId: true },
      });
      expect(prisma.oAuthAccount.create).not.toHaveBeenCalled();
      expect(userService.createUser).not.toHaveBeenCalled();
      expect(authService.completeMfaLogin).toHaveBeenCalledWith('u-linked', '10.0.0.1');
      if (!('mfaRequired' in result)) {
        expect(result.user.id).toBe('u-x');
      } else {
        throw new Error('expected a full session, got an MFA challenge');
      }
    });

    it('links a new OAuthAccount to an existing user matched by email', async () => {
      mockGoogleFetch();
      prisma.oAuthAccount.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({ id: 'u-existing' });

      await service.handleCallback('google', 'code', 's', 's');

      expect(prisma.oAuthAccount.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-existing',
          provider: 'google',
          providerId: 'google-123',
          email: 'jane@ems.local',
        },
      });
      expect(authService.completeMfaLogin).toHaveBeenCalledWith('u-existing', undefined);
    });

    it('creates a verified user + employee scaffold for a first-time OAuth user', async () => {
      mockGoogleFetch();
      prisma.oAuthAccount.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await service.handleCallback('google', 'code', 's', 's');

      expect(passwordService.hash).toHaveBeenCalled();
      expect(userService.createUser).toHaveBeenCalledWith(
        'jane@ems.local',
        'argon2-hash',
        'Jane',
        'Smith',
        ['EMPLOYEE'],
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-new' },
        data: { emailVerified: true },
      });
      expect(prisma.oAuthAccount.create).toHaveBeenCalledWith({
        data: {
          userId: 'u-new',
          provider: 'google',
          providerId: 'google-123',
          email: 'jane@ems.local',
        },
      });
    });

    it('wraps IdP failures in a generic error (no token leakage)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });

      const err = await service.handleCallback('google', 'code', 's', 's').catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/failed/i);
      expect(err.message).not.toContain('400');
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('rejects an IdP-unverified email before any linking or account creation', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'idp-at' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ ...googleProfile, email_verified: false }),
        });
      prisma.oAuthAccount.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      const err = await service.handleCallback('google', 'code', 's', 's').catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/verified email/i);
      expect(prisma.oAuthAccount.findUnique).not.toHaveBeenCalled();
      expect(userService.createUser).not.toHaveBeenCalled();
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('returns an MFA challenge instead of a session for MFA-enrolled users', async () => {
      mockGoogleFetch();
      prisma.oAuthAccount.findUnique.mockResolvedValue({ userId: 'u-mfa' });
      // Email lookup is skipped on the linked-account path; the MFA read is
      // the only user.findUnique call → enrolled.
      prisma.user.findUnique.mockResolvedValue({ mfaEnabled: true });

      const result = await service.handleCallback('google', 'code', 's', 's');

      expect(tokenService.createMfaChallengeToken).toHaveBeenCalledWith('u-mfa');
      expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge-abc' });
      expect(authService.completeMfaLogin).not.toHaveBeenCalled();
    });

    it('issues a full session when MFA is not enrolled', async () => {
      mockGoogleFetch();
      prisma.oAuthAccount.findUnique.mockResolvedValue({ userId: 'u-plain' });
      prisma.user.findUnique.mockResolvedValue({ mfaEnabled: false });

      const result = await service.handleCallback('google', 'code', 's', 's');

      expect(tokenService.createMfaChallengeToken).not.toHaveBeenCalled();
      expect(authService.completeMfaLogin).toHaveBeenCalledWith('u-plain', undefined);
      expect((result as any).user.id).toBe('u-x');
    });
  });
});
