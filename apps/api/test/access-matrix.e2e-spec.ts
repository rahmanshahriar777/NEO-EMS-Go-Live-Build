/**
 * E2E: route-by-role access matrix (B1 regression net).
 *
 * Runs against a REAL booted Nest application (no mocks) and asserts, over
 * HTTP with supertest:
 *   - every @Public() route is reachable without credentials,
 *   - every protected route returns 401 with no/invalid credentials,
 *   - a valid token with the WRONG role returns 403 (not 401).
 *
 * Requires: Postgres reachable at E2E_DATABASE_URL (or DATABASE_URL) with
 * the Prisma schema migrated. Redis/MinIO are NOT required (queue layer is
 * fail-open; no document bodies are fetched here).
 *
 * When no database is reachable the suite degrades to a single passing
 * "skipped" test — see test/README.md for the manual command.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
// AppModule is required lazily inside beforeAll (not statically imported)
// so a type error in another in-progress file within the module graph
// cannot break e2e compilation. At runtime require() executes the real
// module; type errors never block runtime.
import { e2eDbOrSkip } from './e2e-utils';

const gate = e2eDbOrSkip('access-matrix');

interface MatrixRow {
  /** Human label for the test name. */
  name: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  /** Expected status for an unauthenticated request. */
  unauthenticated: 401 | 404;
  /** Roles that must be REJECTED with 403 when presenting a wrong-role token. */
  wrongRoleRejected?: boolean;
}

const PUBLIC_ROUTES: MatrixRow[] = [
  { name: 'POST /auth/login is public', method: 'post', path: '/api/v1/auth/login', unauthenticated: 401 },
  { name: 'POST /auth/register is public', method: 'post', path: '/api/v1/auth/register', unauthenticated: 401 },
  { name: 'POST /auth/refresh is public', method: 'post', path: '/api/v1/auth/refresh', unauthenticated: 401 },
  { name: 'GET /health/liveness is public', method: 'get', path: '/api/v1/health/liveness', unauthenticated: 404 },
];

const PROTECTED_ROUTES: MatrixRow[] = [
  { name: 'POST /ai/generate requires HR role', method: 'post', path: '/api/v1/ai/generate', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'GET /employees/:id requires auth', method: 'get', path: '/api/v1/employees/some-id', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'PATCH /employees/:id requires HR/manager', method: 'patch', path: '/api/v1/employees/some-id', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'GET /documents/:id requires auth', method: 'get', path: '/api/v1/documents/some-id', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'GET /documents/:id/download requires auth (B5)', method: 'get', path: '/api/v1/documents/some-id/download', unauthenticated: 401 },
  { name: 'POST /payroll/runs/:id/disburse requires HR role', method: 'post', path: '/api/v1/payroll/runs/some-id/disburse', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'GET /audit/verify requires HR role', method: 'get', path: '/api/v1/audit/verify', unauthenticated: 401, wrongRoleRejected: true },
  { name: 'PATCH /leave-requests/:id/approve requires manager/HR', method: 'patch', path: '/api/v1/leave-requests/some-id/approve', unauthenticated: 401, wrongRoleRejected: true },
];

(gate.available ? describe : describe.skip)('e2e: route-by-role access matrix', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Throwaway test secrets — never real credentials (see test/README.md).
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = gate.target!.url;
    process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
    process.env.DOCUMENT_ENCRYPTION_KEY = 'e2e-test-document-encryption-key-32b!!';

    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  describe('public routes', () => {
    for (const row of PUBLIC_ROUTES) {
      it(`${row.name} — reachable without credentials (not 401-auth-wall)`, async () => {
        // Public auth routes validate the BODY (400/422 on empty body proves
        // we got past the guard chain); anything other than 401 means the
        // route is not auth-walled.
        const res = await (request(app.getHttpServer()) as any)[row.method](row.path).send({});
        expect(res.status).not.toBe(401);
      });
    }
  });

  describe('protected routes: 401 without credentials', () => {
    for (const row of PROTECTED_ROUTES) {
      it(`${row.name} — 401 unauthenticated`, async () => {
        const res = await (request(app.getHttpServer()) as any)[row.method](row.path).send({});
        expect(res.status).toBe(401);
      });

      it(`${row.name} — 401 with a garbage bearer token`, async () => {
        const res = await (request(app.getHttpServer()) as any)
          [row.method](row.path)
          .set('Authorization', 'Bearer not-a-real-token')
          .send({});
        expect(res.status).toBe(401);
      });
    }
  });

  describe('protected routes: 403 with wrong role', () => {
    // A wrong-role 403 assertion needs a VALID token minted for a user that
    // lacks the required role. Minting requires a seeded user; the seed
    // helper below creates one EMPLOYEE user per suite run. If seeding is
    // unavailable in the target database these tests fail loudly — that is
    // intentional: a silent pass would hide a broken matrix.
    let employeeToken: string;

    beforeAll(async () => {
      // Minimal seed via the public registration path would couple to the
      // invitation flow; instead resolve the JwtService directly and mint a
      // token for a synthetic EMPLOYEE principal. The signature is valid
      // (same secret as the app), so 401-vs-403 discrimination is real.
      const { JwtService } = await import('@nestjs/jwt');
      const { ConfigService } = await import('@nestjs/config');
      const jwt = app.get(JwtService);
      const config = app.get(ConfigService);
      employeeToken = jwt.sign(
        {
          sub: 'e2e-employee-user',
          email: 'e2e-employee@ems.local',
          roles: ['EMPLOYEE'],
          permissions: [],
          employeeId: 'e2e-employee-id',
        },
        {
          secret: config.get<string>('jwt.accessSecret'),
          expiresIn: '15m',
        },
      );
    });

    for (const row of PROTECTED_ROUTES.filter((r) => r.wrongRoleRejected)) {
      it(`${row.name} — 403 for EMPLOYEE role`, async () => {
        const res = await (request(app.getHttpServer()) as any)
          [row.method](row.path)
          .set('Authorization', `Bearer ${employeeToken}`)
          .send({});
        // 403 = authenticated but forbidden. (404 would mean the route path
        // itself is wrong — also a failure, surfaced by this assertion.)
        expect(res.status).toBe(403);
      });
    }
  });
});

if (!gate.available) {
  describe('e2e: route-by-role access matrix', () => {
    gate.registerSkip();
  });
}
