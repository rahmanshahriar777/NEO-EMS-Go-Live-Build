/**
 * MfaController + SessionsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MfaController } from './mfa.controller';
import { SessionsController } from './sessions.controller';
import { MfaService } from './mfa.service';
import { setAuthCookies } from '../../common/cookies/auth-cookies';

// auth-cookies pulls an ESM-only chain (via jwt.strategy) that ts-jest cannot
// parse; the established pattern (auth.controller.spec.ts) is to mock it.
// otplib pulls @scure/base (ESM-only) the same way — mocked as in mfa.service.spec.ts.
jest.mock('../../common/cookies/auth-cookies', () => ({
  setAuthCookies: jest.fn(),
}));
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

describe('MfaController', () => {
  let controller: MfaController;
  let mfaService: any;

  const user: any = { sub: 'user-1', email: 'u@ems.local' };

  beforeEach(async () => {
    mfaService = {
      setupTotp: jest.fn(),
      verifySetup: jest.fn(),
      disableMfa: jest.fn(),
      getStatus: jest.fn(),
      completeChallenge: jest.fn(),
      listSessions: jest.fn(),
      revokeSession: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MfaController],
      providers: [
        { provide: MfaService, useValue: mfaService },
        { provide: ConfigService, useValue: { get: jest.fn((k: string, f?: any) => f) } },
      ],
    }).compile();

    controller = module.get<MfaController>(MfaController);
  });

  it('setup starts TOTP enrollment for the current user', async () => {
    mfaService.setupTotp.mockResolvedValue({ secret: 'S', otpauthUrl: 'otpauth://x' });
    const res = await controller.setup(user);
    expect(mfaService.setupTotp).toHaveBeenCalledWith('user-1', 'u@ems.local');
    expect(res).toEqual({ success: true, data: { secret: 'S', otpauthUrl: 'otpauth://x' } });
  });

  it('verify confirms enrollment with the TOTP code', async () => {
    mfaService.verifySetup.mockResolvedValue({ recoveryCodes: ['A', 'B'] });
    const res = await controller.verify(user, { token: '123456' } as any);
    expect(mfaService.verifySetup).toHaveBeenCalledWith('user-1', '123456');
    expect(res.success).toBe(true);
    expect(res.data.recoveryCodes).toEqual(['A', 'B']);
  });

  it('disable forwards the password', async () => {
    mfaService.disableMfa.mockResolvedValue(undefined);
    const res = await controller.disable(user, { password: 'pw' } as any);
    expect(mfaService.disableMfa).toHaveBeenCalledWith('user-1', 'pw');
    expect(res).toEqual({ success: true, message: 'MFA disabled' });
  });

  it('status delegates to the service', async () => {
    mfaService.getStatus.mockResolvedValue({ enabled: true });
    const res = await controller.status(user);
    expect(mfaService.getStatus).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ success: true, data: { enabled: true } });
  });

  it('challenge completes login and never puts tokens in the body', async () => {
    const tokens = { accessToken: 'at', refreshToken: 'rt' };
    mfaService.completeChallenge.mockResolvedValue({ user: { id: 'user-1' }, tokens });
    const req: any = { ip: '10.0.0.1', socket: {} };
    const res: any = { cookie: jest.fn() };

    const out = await controller.challenge(
      { challengeToken: 'ch', code: '123456' } as any,
      req,
      res,
    );

    expect(mfaService.completeChallenge).toHaveBeenCalledWith('ch', '123456', '10.0.0.1');
    expect(setAuthCookies).toHaveBeenCalledWith(res, tokens, expect.anything());
    expect(out.success).toBe(true);
    expect(out.data.user).toEqual({ id: 'user-1' });
    expect(JSON.stringify(out)).not.toContain('rt');
  });
});

describe('SessionsController', () => {
  let controller: SessionsController;
  let mfaService: any;

  const user: any = { sub: 'user-1', email: 'u@ems.local' };

  beforeEach(async () => {
    mfaService = { listSessions: jest.fn(), revokeSession: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SessionsController],
      providers: [{ provide: MfaService, useValue: mfaService }],
    }).compile();

    controller = module.get<SessionsController>(SessionsController);
  });

  it('list returns the user sessions', async () => {
    mfaService.listSessions.mockResolvedValue([{ familyId: 'f1' }]);
    const res = await controller.list(user);
    expect(mfaService.listSessions).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ success: true, data: [{ familyId: 'f1' }] });
  });

  it('revokeOne revokes the session', async () => {
    mfaService.revokeSession.mockResolvedValue(undefined);
    const res = await controller.revokeOne(user, 'f1');
    expect(mfaService.revokeSession).toHaveBeenCalledWith('user-1', 'f1');
    expect(res).toEqual({ success: true, message: 'Session revoked' });
  });
});
