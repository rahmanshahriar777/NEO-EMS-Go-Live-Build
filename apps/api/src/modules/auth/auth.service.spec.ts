import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QueueService } from '../../core/queues/queue.service';
import { EmailService } from '../../common/email/email.service';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { SystemRole } from '@ems/shared';

describe('AuthService', () => {
  let authService: AuthService;
  let userService: Partial<UserService>;
  let passwordService: Partial<PasswordService>;
  let tokenService: Partial<TokenService>;
  let prismaService: Partial<PrismaService>;
  let queueService: Partial<QueueService>;
  let emailService: Partial<EmailService>;
  let configGet: jest.Mock;

  const verifiedUser = (overrides: Record<string, any> = {}) => ({
    id: 'user-1',
    email: 'test@ems.local',
    // Argon2id-formatted so needsRehash() is false by default in tests.
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    isActive: true,
    emailVerified: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    roles: [{ role: { name: SystemRole.EMPLOYEE, permissions: [] } }],
    employee: { id: 'emp-1', firstName: 'John', lastName: 'Doe', employeeNumber: 'EMP-001' },
    ...overrides,
  });

  beforeEach(async () => {
    userService = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      createUser: jest.fn(),
      updatePassword: jest.fn(),
    };

    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed_password_string'),
      verify: jest.fn(),
      verifyDummy: jest.fn().mockResolvedValue(false),
      needsRehash: jest.fn().mockReturnValue(false),
      rehash: jest.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$bmV3$bmV3'),
    };

    tokenService = {
      generateTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock_access_token',
        refreshToken: 'mock_refresh_token',
        tokenType: 'Bearer',
        expiresIn: 900,
      }),
      rotateRefreshToken: jest.fn(),
      revokeToken: jest.fn(),
      revokeAllUserTokens: jest.fn(),
      createMfaChallengeToken: jest.fn().mockResolvedValue('mock-challenge-token'),
    };

    prismaService = {
      loginAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
      } as any,
      user: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      } as any,
    };

    // QueueService is a required AuthService dependency (F11 verification
    // emails are enqueued); without this mock Nest DI fails to resolve.
    queueService = {
      enqueueNotification: jest.fn().mockResolvedValue('job-1'),
    };

    emailService = {
      sendTemplated: jest.fn().mockResolvedValue('job-1'),
    };

    configGet = jest.fn((key: string, fallback?: any) => {
      if (key === 'security.allowPublicRegistration') return true;
      if (key === 'frontendUrl') return 'http://localhost:3000';
      return fallback;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: PasswordService, useValue: passwordService },
        { provide: TokenService, useValue: tokenService },
        { provide: PrismaService, useValue: prismaService },
        { provide: QueueService, useValue: queueService },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  it('should throw UnauthorizedException if user not found', async () => {
    (userService.findByEmail as jest.Mock).mockResolvedValue(null);

    await expect(
      authService.login({ email: 'unknown@ems.local', password: 'Password123!' }),
    ).rejects.toThrow(UnauthorizedException);

    expect(passwordService.verifyDummy).toHaveBeenCalledWith('Password123!');
  });

  it('should throw UnauthorizedException if password does not match', async () => {
    (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser());
    (passwordService.verify as jest.Mock).mockResolvedValue(false);

    await expect(
      authService.login({ email: 'test@ems.local', password: 'WrongPassword' }),
    ).rejects.toThrow(UnauthorizedException);

    // failure counter incremented
    expect((prismaService.user as any).update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { failedLoginAttempts: 1 },
    });
  });

  it('should login successfully and return tokens and user profile', async () => {
    (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser());
    (passwordService.verify as jest.Mock).mockResolvedValue(true);

    const result = await authService.login({ email: 'test@ems.local', password: 'Password123!' });

    expect('tokens' in result && result.tokens.accessToken).toBe('mock_access_token');
    expect('user' in result && result.user.email).toBe('test@ems.local');
    expect('user' in result && result.user.roles).toContain(SystemRole.EMPLOYEE);
  });

  describe('Phase 1 login hardening (item 5): password first, one generic message', () => {
    it('verifies the password BEFORE checking lockout state', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(
        verifiedUser({ lockedUntil: new Date(Date.now() + 10 * 60 * 1000), failedLoginAttempts: 5 }),
      );
      (passwordService.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        authService.login({ email: 'test@ems.local', password: 'WrongPassword' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(passwordService.verify).toHaveBeenCalled();
    });

    it('returns the generic message for a locked account even with the correct password', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(
        verifiedUser({ lockedUntil: new Date(Date.now() + 10 * 60 * 1000), failedLoginAttempts: 5 }),
      );
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      const err = await authService
        .login({ email: 'test@ems.local', password: 'Password123!' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('Invalid email or password');
      expect(err.message).not.toMatch(/lock/i);
      expect(tokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('returns the generic message for a deactivated account', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser({ isActive: false }));
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      const err = await authService
        .login({ email: 'test@ems.local', password: 'Password123!' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('Invalid email or password');
      expect(err.message).not.toMatch(/deactiv/i);
    });

    it('returns the generic message for an unverified email (no more EMAIL_NOT_VERIFIED oracle)', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser({ emailVerified: false }));
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      const err = await authService
        .login({ email: 'test@ems.local', password: 'Password123!' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('Invalid email or password');
      expect(err.message).not.toMatch(/verif/i);
      expect(tokenService.generateTokens).not.toHaveBeenCalled();
    });

    it('re-hashes a legacy password hash to Argon2id on successful login', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(
        verifiedUser({ passwordHash: 'pbkdf2$100000$salt$hash' }),
      );
      (passwordService.verify as jest.Mock).mockResolvedValue(true);
      (passwordService.needsRehash as jest.Mock).mockReturnValue(true);

      await authService.login({ email: 'test@ems.local', password: 'Password123!' });

      expect(passwordService.rehash).toHaveBeenCalledWith('Password123!');
      expect(userService.updatePassword).toHaveBeenCalledWith(
        'user-1',
        '$argon2id$v=19$m=19456,t=2,p=1$bmV3$bmV3',
      );
    });

    it('does not re-hash when the stored hash is already Argon2id', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser());
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      await authService.login({ email: 'test@ems.local', password: 'Password123!' });

      expect(passwordService.rehash).not.toHaveBeenCalled();
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });
  });

  describe('B2 invite-only registration gate', () => {
    it('rejects registration with 403 when ALLOW_PUBLIC_REGISTRATION=false', async () => {
      configGet.mockImplementation((key: string, fallback?: any) =>
        key === 'security.allowPublicRegistration' ? false : fallback,
      );

      await expect(
        authService.register({
          email: 'new@ems.local',
          password: 'LongEnoughPassword123!',
          firstName: 'Jane',
          lastName: 'Smith',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(userService.createUser).not.toHaveBeenCalled();
    });
  });

  describe('F11 email verification', () => {
    it('should create a hashed verification token on register and issue NO session tokens', async () => {
      (userService.createUser as jest.Mock).mockResolvedValue({
        user: { id: 'user-2', email: 'new@ems.local' },
        employee: { id: 'emp-2', firstName: 'Jane', lastName: 'Smith', employeeNumber: 'EMP-2026-0002' },
      });

      const result = await authService.register({
        email: 'new@ems.local',
        password: 'LongEnoughPassword123!',
        firstName: 'Jane',
        lastName: 'Smith',
      });

      expect(tokenService.generateTokens).not.toHaveBeenCalled();
      expect(result.message).toMatch(/verify your email/i);

      const updateCall = (prismaService.user as any).update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'user-2' });
      expect(updateCall.data.emailVerified).toBe(false);
      // stored hashed (64 hex chars), never the raw token
      expect(updateCall.data.emailVerificationToken).toMatch(/^[a-f0-9]{64}$/);
      expect(updateCall.data.emailVerificationExpires).toBeInstanceOf(Date);
      // verification email goes through the templated email service
      expect(emailService.sendTemplated).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@ems.local',
          userId: 'user-2',
          template: 'verification',
        }),
      );
    });

    it('should verify email with a valid token and clear it (single-use)', async () => {
      const future = new Date(Date.now() + 60_000);
      (prismaService.user as any).findFirst.mockResolvedValue({
        id: 'user-2',
        emailVerificationExpires: future,
        emailVerified: false,
      });

      await authService.verifyEmail('raw-token-value');

      expect((prismaService.user as any).update).toHaveBeenCalledWith({
        where: { id: 'user-2' },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpires: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    });

    it('should reject an expired verification token', async () => {
      (prismaService.user as any).findFirst.mockResolvedValue({
        id: 'user-2',
        emailVerificationExpires: new Date(Date.now() - 1000),
        emailVerified: false,
      });

      await expect(authService.verifyEmail('stale-token')).rejects.toThrow(BadRequestException);
      expect((prismaService.user as any).update).not.toHaveBeenCalled();
    });

    it('should reject an unknown verification token', async () => {
      (prismaService.user as any).findFirst.mockResolvedValue(null);

      await expect(authService.verifyEmail('nope')).rejects.toThrow(BadRequestException);
    });

    it('resendVerification should be enumeration-safe for unknown emails', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(null);

      await expect(
        authService.resendVerification('ghost@ems.local'),
      ).resolves.toBeUndefined();
      expect((prismaService.user as any).update).not.toHaveBeenCalled();
    });
  });

  describe('Phase 2 MFA login step', () => {
    it('returns an MFA challenge instead of tokens when MFA is enabled', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(
        verifiedUser({ mfaEnabled: true }),
      );
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      const result = await authService.login({ email: 'test@ems.local', password: 'Password123!' });

      expect(result).toEqual({ mfaRequired: true, challengeToken: 'mock-challenge-token' });
      expect(tokenService.createMfaChallengeToken).toHaveBeenCalledWith('user-1');
      expect(tokenService.generateTokens).not.toHaveBeenCalled();
    });
  });

  describe('F23 account lockout', () => {
    it('should lock the account for 15 minutes after 5 consecutive failures', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(verifiedUser({ failedLoginAttempts: 4 }));
      (passwordService.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        authService.login({ email: 'test@ems.local', password: 'WrongPassword' }),
      ).rejects.toThrow(UnauthorizedException);

      const updateCall = (prismaService.user as any).update.mock.calls[0][0];
      expect(updateCall.data.failedLoginAttempts).toBe(5);
      expect(updateCall.data.lockedUntil).toBeInstanceOf(Date);
      const skew = updateCall.data.lockedUntil.getTime() - Date.now();
      expect(skew).toBeGreaterThan(14 * 60 * 1000);
      expect(skew).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    it('should reset failure counters on successful login', async () => {
      (userService.findByEmail as jest.Mock).mockResolvedValue(
        verifiedUser({ failedLoginAttempts: 2 }),
      );
      (passwordService.verify as jest.Mock).mockResolvedValue(true);

      await authService.login({ email: 'test@ems.local', password: 'Password123!' });

      expect((prismaService.user as any).update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });
  });

  describe('session & profile helpers', () => {
    it('refreshToken delegates to token rotation', async () => {
      (tokenService.rotateRefreshToken as jest.Mock).mockResolvedValue({ accessToken: 'new-at' });

      const result = await authService.refreshToken('fam-1.raw-token', '10.0.0.1');

      expect(tokenService.rotateRefreshToken).toHaveBeenCalledWith('fam-1.raw-token', '10.0.0.1');
      expect(result).toEqual({ accessToken: 'new-at' });
    });

    it('logout with a token revokes that token', async () => {
      await authService.logout('fam-1.raw-token');

      expect(tokenService.revokeToken).toHaveBeenCalledWith('fam-1.raw-token');
      expect(tokenService.revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('logout with a userId revokes all user tokens', async () => {
      await authService.logout(undefined, 'user-1');

      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
      expect(tokenService.revokeToken).not.toHaveBeenCalled();
    });

    it('getMe returns the user profile', async () => {
      (userService.findById as jest.Mock).mockResolvedValue(verifiedUser());

      const me = await authService.getMe('user-1');

      expect(me.email).toBe('test@ems.local');
      expect(me.roles).toEqual([SystemRole.EMPLOYEE]);
      expect(me.employeeNumber).toBe('EMP-001');
    });

    it('getMe throws UnauthorizedException for an unknown user', async () => {
      (userService.findById as jest.Mock).mockResolvedValue(null);

      await expect(authService.getMe('ghost')).rejects.toThrow(UnauthorizedException);
    });

    it('changePassword rejects an unknown user', async () => {
      ((prismaService.user as any).findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        authService.changePassword('ghost', { currentPassword: 'a', newPassword: 'b' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('changePassword rejects a wrong current password', async () => {
      ((prismaService.user as any).findUnique as jest.Mock).mockResolvedValue({ id: 'user-1', passwordHash: 'h' });
      (passwordService.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        authService.changePassword('user-1', { currentPassword: 'wrong', newPassword: 'New123!!' }),
      ).rejects.toThrow(BadRequestException);
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });

    it('changePassword updates the hash and revokes all sessions', async () => {
      ((prismaService.user as any).findUnique as jest.Mock).mockResolvedValue({ id: 'user-1', passwordHash: 'old' });
      (passwordService.verify as jest.Mock).mockResolvedValue(true);
      (passwordService.hash as jest.Mock).mockResolvedValue('new-hash');

      await authService.changePassword('user-1', { currentPassword: 'old', newPassword: 'New123!!' });

      expect(userService.updatePassword).toHaveBeenCalledWith('user-1', 'new-hash');
      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });
  });
});
