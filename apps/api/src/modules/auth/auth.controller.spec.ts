/**
 * AuthController wiring tests — delegation to AuthService and to the
 * httpOnly-cookie helpers. Guard behavior is covered by
 * common/guards/access-matrix.spec.ts.
 *
 * NOTE: '../../common/cookies/auth-cookies' and './auth.service' are mocked
 * at the module level. The controller's decorator metadata and delegation
 * wiring are real; the mocks only stand in for modules whose transitive
 * imports are currently uncompilable in this environment ('argon2' declared
 * in package.json but not installed; config/configuration.ts carries another
 * worker's in-progress type errors). The cookie-setting semantics themselves
 * (httpOnly, SameSite, paths) belong to an auth-cookies unit test.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { setAuthCookies, clearAuthCookies } from '../../common/cookies/auth-cookies';
import { SystemRole, JwtPayload } from '@ems/shared';

jest.mock('./auth.service', () => ({
  AuthService: class AuthService {},
}));
jest.mock('../../common/cookies/auth-cookies', () => ({
  setAuthCookies: jest.fn(),
  clearAuthCookies: jest.fn(),
  getCookieValue: jest.fn((_req: any, _name: string) => null),
  ACCESS_TOKEN_COOKIE: 'ems_at',
  REFRESH_TOKEN_COOKIE: 'ems_rt',
}));

const user = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'user@ems.local',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: any;
  let configService: any;

  const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };
  const req: any = { ip: '10.0.0.1', socket: {}, headers: {} };

  beforeEach(async () => {
    authService = {
      login: jest.fn(),
      register: jest.fn(),
      verifyEmail: jest.fn(),
      resendVerification: jest.fn(),
      refreshToken: jest.fn(),
      logout: jest.fn(),
      getMe: jest.fn(),
      changePassword: jest.fn(),
    };
    configService = { get: jest.fn((k: string, f?: any) => f) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    jest.clearAllMocks();
  });

  it('login delegates to the service and sets auth cookies (no tokens in the body)', async () => {
    const tokens = { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresIn: 900 };
    authService.login.mockResolvedValue({ user: { id: 'user-1' }, tokens });

    const result = await controller.login({ email: 'a@b.c', password: 'x' } as any, req, res);

    expect(authService.login).toHaveBeenCalledWith(
      { email: 'a@b.c', password: 'x' },
      '10.0.0.1',
      undefined,
    );
    expect(setAuthCookies).toHaveBeenCalledWith(res, tokens, configService);
    expect(result).toEqual({
      success: true,
      message: 'Logged in successfully',
      data: { user: { id: 'user-1' } },
    });
    expect(JSON.stringify(result)).not.toContain('accessToken');
  });

  it('login with MFA required returns the challenge payload and sets no cookies', async () => {
    authService.login.mockResolvedValue({ mfaRequired: true, challengeToken: 'ch-1' });

    const result = await controller.login({ email: 'a@b.c', password: 'x' } as any, req, res);

    expect(result).toEqual({
      success: true,
      mfaRequired: true,
      challengeToken: 'ch-1',
      message: 'Second factor required. Submit your authenticator code to complete login.',
    });
    expect(setAuthCookies).not.toHaveBeenCalled();
  });

  it('register returns the user with NO tokens in the body', async () => {
    authService.register.mockResolvedValue({ user: { id: 'u-1' }, message: 'verify' });

    const result = await controller.register({ email: 'a@b.c', password: 'x' } as any, req);

    expect(result.data).toEqual({ user: { id: 'u-1' } });
    expect(JSON.stringify(result)).not.toContain('accessToken');
  });

  it('refresh rotates via the service and re-sets cookies (cookies-only response)', async () => {
    const tokens = { accessToken: 'at2', refreshToken: 'rt2' };
    authService.refreshToken.mockResolvedValue(tokens);

    const result = await controller.refresh({ refreshToken: 'body-token' } as any, req, res);

    expect(authService.refreshToken).toHaveBeenCalledWith('body-token', '10.0.0.1');
    expect(setAuthCookies).toHaveBeenCalledWith(res, tokens, configService);
    expect(result).toEqual({ success: true, message: 'Token refreshed successfully' });
    expect(JSON.stringify(result)).not.toContain('rt2');
  });

  it('refresh without any presented token -> 400', async () => {
    await expect(controller.refresh({} as any, req, res)).rejects.toThrow(BadRequestException);
    expect(authService.refreshToken).not.toHaveBeenCalled();
  });

  it('logout revokes and clears cookies', async () => {
    await controller.logout({ refreshToken: 'rt' }, user(), res);

    expect(authService.logout).toHaveBeenCalledWith('rt', 'user-1');
    expect(clearAuthCookies).toHaveBeenCalledWith(res, configService);
  });

  it('getMe and changePassword forward the caller identity', async () => {
    authService.getMe.mockResolvedValue({ id: 'user-1' });
    await controller.getMe('user-1');
    expect(authService.getMe).toHaveBeenCalledWith('user-1');

    await controller.changePassword('user-1', { currentPassword: 'a', newPassword: 'b' } as any);
    expect(authService.changePassword).toHaveBeenCalledWith('user-1', {
      currentPassword: 'a',
      newPassword: 'b',
    });
  });

  it('verifyEmail returns a confirmation message', async () => {
    const result = await controller.verifyEmail({ token: 'tok' } as any);
    expect(authService.verifyEmail).toHaveBeenCalledWith('tok');
    expect(result.success).toBe(true);
  });
});
