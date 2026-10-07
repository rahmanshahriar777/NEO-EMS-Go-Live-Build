import { RolesGuard } from './roles.guard';
import { PermissionsGuard } from './permissions.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SystemRole } from '@ems/shared';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(userRoles: SystemRole[]): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            sub: 'user-1',
            roles: userRoles,
          },
        }),
      }),
    } as any;
  }

  it('should allow access if no roles are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
    const ctx = createMockContext([SystemRole.EMPLOYEE]);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow SUPER_ADMIN access to any role-protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([SystemRole.HR_ADMIN]);
    const ctx = createMockContext([SystemRole.SUPER_ADMIN]);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny access if user lacks required role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([SystemRole.HR_ADMIN]);
    const ctx = createMockContext([SystemRole.EMPLOYEE]);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow access to user with custom role if they possess equivalent permissions', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([SystemRole.HR_ADMIN]);
    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            sub: 'user-1',
            roles: ['CUSTOM_HR_SPECIALIST'],
            permissions: ['EMPLOYEE:MANAGE'],
          },
        }),
      }),
    } as any;

    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('PermissionsGuard (F21)', () => {
  let guard: PermissionsGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  function createMockContext(permissions: string[]): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            sub: 'user-1',
            roles: [SystemRole.EMPLOYEE],
            permissions,
          },
        }),
      }),
    } as any;
  }

  it('should pass through when no @Permissions() metadata is present (global registration is behaviour-preserving)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = createMockContext([]);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow access when the user holds every required permission', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['AUDIT_LOG:READ']);
    const ctx = createMockContext(['AUDIT_LOG:READ', 'EMPLOYEE:READ']);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny access when a required permission is missing', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['AUDIT_LOG:READ']);
    const ctx = createMockContext(['EMPLOYEE:READ']);

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should let SUPER_ADMIN bypass permission checks', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['PAYROLL:APPROVE']);
    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: 'admin-1', roles: [SystemRole.SUPER_ADMIN], permissions: [] },
        }),
      }),
    } as any;

    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let parentCanActivate: jest.SpyInstance;

  function createMockContext(): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as any;
  }

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtAuthGuard(reflector);
    // Spy the passport base class (AuthGuard('jwt')) canActivate that
    // JwtAuthGuard delegates to via super.canActivate().
    parentCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true);
  });

  afterEach(() => {
    parentCanActivate.mockRestore();
  });

  it('should bypass authentication for @Public() routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    expect(guard.canActivate(createMockContext())).toBe(true);
    expect(parentCanActivate).not.toHaveBeenCalled();
  });

  it('should delegate to the passport JWT strategy for protected routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    parentCanActivate.mockReturnValue(true);

    expect(guard.canActivate(createMockContext())).toBe(true);
    expect(parentCanActivate).toHaveBeenCalled();
  });

  it('should propagate the strategy denial for protected routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    parentCanActivate.mockReturnValue(false);

    expect(guard.canActivate(createMockContext())).toBe(false);
  });

  it('handleRequest should throw the original error when present', () => {
    const err = new Error('strategy exploded');

    expect(() => guard.handleRequest(err, null, null)).toThrow(err);
  });

  it('handleRequest should throw UnauthorizedException when no user was resolved', () => {
    expect(() => guard.handleRequest(null, null, { message: 'No auth token' })).toThrow(
      UnauthorizedException,
    );
  });

  it('handleRequest should return the authenticated user', () => {
    const user = { sub: 'user-1', roles: [SystemRole.EMPLOYEE] };

    expect(guard.handleRequest(null, user, null)).toBe(user);
  });
});
