/**
 * Route-by-role access matrix (B1 regression net) — unit level, no DB.
 *
 * Unlike the e2e matrix (test/access-matrix.e2e-spec.ts), this spec never
 * boots the app: it reads the REAL decorator metadata (@Public, @Roles,
 * @UseGuards, route paths) off the actual controller classes and runs the
 * REAL guard implementations (JwtAuthGuard, RolesGuard, PermissionsGuard)
 * with a REAL Reflector against that metadata.
 *
 * It catches:
 *  - a route losing its JwtAuthGuard before B1 global registration lands;
 *  - someone adding @Public() to a sensitive route;
 *  - a route gaining/losing @Roles() metadata;
 *  - global APP_GUARD registration order regressions (JwtAuthGuard ->
 *    RolesGuard -> PermissionsGuard).
 *
 * If B5 (document download) or B1 (global JwtAuthGuard) lands, the
 * explicitly-marked expectations below must be updated — the failure is the
 * signal, not noise.
 */
import 'reflect-metadata';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PermissionsGuard } from './permissions.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { SystemRole } from '@ems/shared';

// AppModule is required lazily (not statically imported) so an unrelated
// type error in another in-progress file pulled into the module graph cannot
// break this spec's compilation. The metadata read below is still the real
// APP_GUARD wiring — require() executes the actual module file at runtime.
// const { AppModule } = require('../../app.module');
//
// NOTE 2026-10-05: the lazy require above does NOT dodge ts-jest
// diagnostics — app.module.ts value-imports config/configuration.ts, which
// currently carries type errors from another worker's in-progress edit, and
// ts-jest reports diagnostics for the whole import graph. Until the module
// graph type-checks cleanly, the global-guard assertions below read the
// wiring declarations from the AppModule SOURCE instead of decorator
// metadata. This still catches B1 regressions (removing or reordering a
// global guard registration fails the test); restore the metadata-based
// read once `npx tsc --noEmit` is green again.
import { AuthController } from '../../modules/auth/auth.controller';
import { AiController } from '../../modules/ai/ai.controller';
import { EmployeesController } from '../../modules/employees/employees.controller';
import { DocumentsController } from '../../modules/documents/documents.controller';
import { PayrollController } from '../../modules/payroll/payroll.controller';
import { LeavesController } from '../../modules/leaves/leaves.controller';
import { AuditController } from '../../core/audit/audit.controller';
import { HealthController } from '../../core/health/health.controller';
import { RolesController } from '../../modules/roles/roles.controller';
import { UsersController } from '../../modules/auth/users.controller';

// ---------------------------------------------------------------------------
// Route introspection over real decorator metadata
// ---------------------------------------------------------------------------

interface RouteInfo {
  controller: string;
  handler: string;
  httpMethod: string;
  path: string;
  isPublic: boolean;
  roles?: SystemRole[];
  permissions?: string[];
  guardNames: string[];
}

const CONTROLLERS = [
  AuthController,
  AiController,
  EmployeesController,
  DocumentsController,
  PayrollController,
  LeavesController,
  AuditController,
  HealthController,
  RolesController,
  UsersController,
] as const;

const HTTP_METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

function guardNames(entry: any): string {
  if (typeof entry === 'function') return entry.name;
  if (entry && typeof entry === 'object' && 'useClass' in entry) return guardNames((entry as any).useClass);
  return String(entry);
}

function scanRoutes(): RouteInfo[] {
  const reflector = new Reflector();
  const routes: RouteInfo[] = [];

  for (const Ctrl of CONTROLLERS) {
    const prefixMeta = Reflect.getMetadata(PATH_METADATA, Ctrl);
    const prefix = Array.isArray(prefixMeta) ? prefixMeta[0] : prefixMeta ?? '';
    const proto = (Ctrl as any).prototype;
    const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, Ctrl) ?? [];

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) continue; // not a route handler

      const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
      const methodGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
      const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, Ctrl]) === true;
      const roles = reflector.getAllAndOverride<SystemRole[]>(ROLES_KEY, [handler, Ctrl]);
      const permissions = reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [handler, Ctrl]);

      const fullPath = `/${prefix}/${Array.isArray(methodPath) ? methodPath[0] : methodPath ?? ''}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, '') || '/';

      routes.push({
        controller: Ctrl.name,
        handler: name,
        httpMethod: HTTP_METHOD_NAMES[method] ?? String(method),
        path: fullPath,
        isPublic,
        roles: roles ?? undefined,
        permissions: permissions ?? undefined,
        guardNames: [...classGuards, ...methodGuards].map(guardNames),
      });
    }
  }
  return routes;
}

import { readFileSync } from 'fs';
import { join } from 'path';

// The specs below assert on CONTROLLER decorator metadata, never on service
// behavior. AuthService is mocked at the module level so this spec does not
// compile auth.service.ts's transitive imports (password.service.ts currently
// imports 'argon2', which is declared in package.json but not installed in
// this environment — `pnpm install` has not been run since the dep was
// added). The metadata under test is unaffected.
jest.mock('../../modules/auth/auth.service', () => ({
  AuthService: class AuthService {},
}));
// payroll.service.ts (another worker's in-progress Phase-2 rewrite) currently
// imports a top-level `fromMinorUnits` from '@ems/shared' that does not exist
// in the installed dist — a compile error in their file, not this spec's
// concern. The decorator metadata under test lives on the controller.
jest.mock('../../modules/payroll/payroll.service', () => ({
  PayrollService: class PayrollService {},
}));
// auth.controller.ts value-imports the cookie helpers, which pull in
// config/configuration.ts (currently uncompilable — see above). The helpers
// are irrelevant to decorator metadata, so they are stubbed here.
jest.mock('../../common/cookies/auth-cookies', () => ({
  setAuthCookies: jest.fn(),
  clearAuthCookies: jest.fn(),
  getCookieValue: jest.fn(() => null),
  ACCESS_TOKEN_COOKIE: 'ems_at',
  REFRESH_TOKEN_COOKIE: 'ems_rt',
}));

/**
 * Declared global APP_GUARD wiring, parsed from the AppModule source.
 * Order-preserving list of useClass names for `provide: APP_GUARD` entries.
 */
function declaredGlobalGuards(): string[] {
  const src = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
  const guards: string[] = [];
  const re = /provide:\s*APP_GUARD[\s\S]*?useClass:\s*([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) guards.push(m[1]);
  return guards;
}

function makeCtx(handler: object, user: any): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

const employeeUser = { sub: 'u-emp', roles: [SystemRole.EMPLOYEE], permissions: [] };
const hrUser = { sub: 'u-hr', roles: [SystemRole.HR_ADMIN], permissions: [] };
const managerUser = { sub: 'u-mgr', roles: [SystemRole.MANAGER], permissions: [] };

describe('access matrix: global guard registration (B1)', () => {
  it('registers RolesGuard and PermissionsGuard as global APP_GUARDs', () => {
    const guards = declaredGlobalGuards();
    expect(guards).toContain('RolesGuard');
    expect(guards).toContain('PermissionsGuard');
  });

  it('when JwtAuthGuard is global, the order is JwtAuthGuard -> RolesGuard -> PermissionsGuard', () => {
    const guards = declaredGlobalGuards();
    if (!guards.includes('JwtAuthGuard')) {
      // B1 not yet landed: JwtAuthGuard is still per-controller. The
      // per-route test below covers that state; this ordering assertion
      // activates the moment B1 registers it globally.
      expect(true).toBe(true);
      return;
    }
    expect(guards.indexOf('JwtAuthGuard')).toBeLessThan(guards.indexOf('RolesGuard'));
    expect(guards.indexOf('RolesGuard')).toBeLessThan(guards.indexOf('PermissionsGuard'));
  });

  it('every non-public route is covered by JwtAuthGuard (global or controller-level)', () => {
    const globals = declaredGlobalGuards();
    const uncovered = scanRoutes().filter(
      (r) => !r.isPublic && ![...globals, ...r.guardNames].includes('JwtAuthGuard'),
    );
    expect(
      uncovered.map((r) => `${r.httpMethod} ${r.path} (${r.controller}.${r.handler})`),
    ).toEqual([]);
  });
});

describe('access matrix: explicit route expectations', () => {
  const routes = scanRoutes();
  const find = (controller: string, handler: string): RouteInfo => {
    const r = routes.find((x) => x.controller === controller && x.handler === handler);
    expect(r).toBeDefined();
    return r!;
  };

  it.each([
    ['AuthController', 'login'],
    ['AuthController', 'register'],
    ['AuthController', 'verifyEmail'],
    ['AuthController', 'resendVerification'],
    ['AuthController', 'refresh'],
  ])('%s.%s is @Public()', (controller, handler) => {
    expect(find(controller, handler).isPublic).toBe(true);
  });

  it.each([
    ['AuthController', 'logout'],
    ['AuthController', 'getMe'],
    ['AuthController', 'changePassword'],
  ])('%s.%s is NOT public', (controller, handler) => {
    expect(find(controller, handler).isPublic).toBe(false);
  });

  it('POST /ai/generate requires SUPER_ADMIN or HR_ADMIN', () => {
    const r = find('AiController', 'generate');
    expect(r.httpMethod).toBe('POST');
    expect(r.path).toBe('/ai/generate');
    expect(r.isPublic).toBe(false);
    expect(r.roles).toEqual([SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN]);
  });

  it('GET /employees/:id is authenticated but has no role restriction', () => {
    const r = find('EmployeesController', 'findOne');
    expect(r.httpMethod).toBe('GET');
    expect(r.isPublic).toBe(false);
    expect(r.roles).toBeUndefined();
  });

  it('PATCH /employees/:id requires SUPER_ADMIN, HR_ADMIN or MANAGER', () => {
    const r = find('EmployeesController', 'update');
    expect(r.httpMethod).toBe('PATCH');
    expect(r.roles).toEqual([SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.MANAGER]);
  });

  it('POST /payroll/runs/:id/disburse requires SUPER_ADMIN or HR_ADMIN', () => {
    const r = find('PayrollController', 'disbursePayrollRun');
    expect(r.httpMethod).toBe('POST');
    expect(r.path).toBe('/payroll/runs/:id/disburse');
    expect(r.isPublic).toBe(false);
    expect(r.roles).toEqual([SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN]);
  });

  it('GET /audit/verify requires SUPER_ADMIN or HR_ADMIN', () => {
    const r = find('AuditController', 'verifyChain');
    expect(r.httpMethod).toBe('GET');
    expect(r.path).toBe('/audit/verify');
    expect(r.roles).toEqual([SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN]);
  });

  it('PATCH /leave-requests/:id/approve requires MANAGER, HR_ADMIN or SUPER_ADMIN', () => {
    const r = find('LeavesController', 'approveLeave');
    expect(r.httpMethod).toBe('PATCH');
    expect(r.roles).toEqual([SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN]);
  });

  it('GET /documents/:id/download (B5) is authenticated with object-level access control', () => {    const r = routes.find(
      (x) => x.controller === 'DocumentsController' && x.path === '/documents/:id/download',
    );
    expect(r).toBeDefined();
    expect(r!.httpMethod).toBe('GET');
    expect(r!.isPublic).toBe(false);
    // No @Roles(): any authenticated role may call it; the service enforces
    // object-level access (owner/uploader/HR). The 401/403 behavior is
    // covered by test/access-matrix.e2e-spec.ts once it is added there.
    expect(r!.roles).toBeUndefined();
  });

  it('roles endpoints are SUPER_ADMIN-only (class-level @Roles)', () => {
    for (const handler of ['listPermissions', 'list', 'create', 'update', 'remove']) {
      const r = find('RolesController', handler);
      expect(r.isPublic).toBe(false);
      expect(r.roles).toEqual([SystemRole.SUPER_ADMIN]);
    }
    const perms = find('RolesController', 'listPermissions');
    expect(perms.httpMethod).toBe('GET');
    expect(perms.path).toBe('/roles/permissions');
  });

  it('auth user admin endpoints require SUPER_ADMIN or HR_ADMIN', () => {
    for (const handler of ['list', 'update']) {
      const r = find('UsersController', handler);
      expect(r.isPublic).toBe(false);
      expect(r.roles).toEqual([SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN]);
    }
  });

  it('health endpoints are explicitly @Public() (B1: public by marker, not by absence)', () => {
    const health = routes.filter((r) => r.controller === 'HealthController');
    expect(health.length).toBeGreaterThan(0);
    for (const r of health) {
      expect(r.isPublic).toBe(true);
    }
  });
});

describe('access matrix: guard-chain behavior on real metadata', () => {
  const reflector = new Reflector();

  it('public route bypasses authentication entirely (JwtAuthGuard returns true)', () => {
    const guard = new JwtAuthGuard(reflector);
    const parent = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockReturnValue(true);
    try {
      const handler = (AuthController.prototype as any).login;
      expect(guard.canActivate(makeCtx(handler, undefined))).toBe(true);
      expect(parent).not.toHaveBeenCalled();
    } finally {
      parent.mockRestore();
    }
  });

  it('unauthenticated access to a protected route maps to 401 (handleRequest)', () => {
    const guard = new JwtAuthGuard(reflector);
    // The passport strategy yields no user -> handleRequest throws the 401.
    expect(() => guard.handleRequest(null, null, { message: 'No auth token' })).toThrow(
      UnauthorizedException,
    );
  });

  it('wrong role on POST /ai/generate -> 403 for EMPLOYEE, pass for HR_ADMIN', () => {
    const guard = new RolesGuard(reflector);
    const handler = (AiController.prototype as any).generate;

    expect(() => guard.canActivate(makeCtx(handler, employeeUser))).toThrow(ForbiddenException);
    expect(guard.canActivate(makeCtx(handler, hrUser))).toBe(true);
  });

  it('wrong role on POST /payroll/runs/:id/disburse -> 403 for MANAGER', () => {
    const guard = new RolesGuard(reflector);
    const handler = (PayrollController.prototype as any).disbursePayrollRun;

    expect(() => guard.canActivate(makeCtx(handler, managerUser))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeCtx(handler, employeeUser))).toThrow(ForbiddenException);
    expect(guard.canActivate(makeCtx(handler, hrUser))).toBe(true);
  });

  it('wrong role on GET /audit/verify -> 403 for EMPLOYEE and MANAGER', () => {
    const guard = new RolesGuard(reflector);
    const handler = (AuditController.prototype as any).verifyChain;

    expect(() => guard.canActivate(makeCtx(handler, employeeUser))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeCtx(handler, managerUser))).toThrow(ForbiddenException);
    expect(guard.canActivate(makeCtx(handler, hrUser))).toBe(true);
  });

  it('wrong role on PATCH /leave-requests/:id/approve -> 403 for EMPLOYEE, pass for MANAGER', () => {
    const guard = new RolesGuard(reflector);
    const handler = (LeavesController.prototype as any).approveLeave;

    expect(() => guard.canActivate(makeCtx(handler, employeeUser))).toThrow(ForbiddenException);
    expect(guard.canActivate(makeCtx(handler, managerUser))).toBe(true);
    expect(guard.canActivate(makeCtx(handler, hrUser))).toBe(true);
  });

  it('PermissionsGuard is behavior-preserving where no @Permissions() metadata exists', () => {
    const guard = new PermissionsGuard(reflector);
    const handler = (PayrollController.prototype as any).disbursePayrollRun;
    // No @Permissions() attached anywhere yet (deliberate, per controller
    // notes) -> guard must pass through for any authenticated user.
    expect(guard.canActivate(makeCtx(handler, employeeUser))).toBe(true);
  });
});
