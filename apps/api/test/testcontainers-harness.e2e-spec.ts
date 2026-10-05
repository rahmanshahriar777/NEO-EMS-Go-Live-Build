/**
 * E2E on real Postgres via testcontainers (Phase 3 item 6).
 *
 * Availability probe (collection time):
 *   1. the `testcontainers` package is resolvable, AND
 *   2. a Docker daemon is reachable.
 *
 * When available the suite:
 *   - starts a PostgreSqlContainer,
 *   - runs `prisma migrate deploy` + `prisma db seed` against it,
 *   - boots the real Nest application,
 *   - asserts the route-by-role matrix at HTTP level (401 unauthenticated,
 *     403 for a properly SEEDED wrong-role user — not a synthetic token),
 *   - walks the invitation → accept → login flow over HTTP.
 *
 * When unavailable (the case in this environment: testcontainers is not
 * installed and no Docker daemon is reachable) the suite degrades to a single
 * passing "skipped" test that records exactly what is needed — the same
 * clean-skip contract as the other e2e specs (see test/README.md).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'child_process';
import * as request from 'supertest';

interface Availability {
  available: boolean;
  reason: string;
}

function probeAvailability(): Availability {
  try {
    require.resolve('testcontainers');
  } catch {
    try {
      require.resolve('@testcontainers/postgresql');
    } catch {
      return {
        available: false,
        reason:
          'testcontainers is not installed. Install it for the API package ' +
          '(`pnpm --filter @ems/api add -D testcontainers @testcontainers/postgresql`) ' +
          'and provide a reachable Docker daemon.',
      };
    }
  }
  // Docker daemon reachability: default unix socket or DOCKER_HOST.
  const { existsSync } = require('fs') as typeof import('fs');
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost && !existsSync('/var/run/docker.sock')) {
    return {
      available: false,
      reason:
        'No Docker daemon reachable (no /var/run/docker.sock and no DOCKER_HOST). ' +
        'Start Docker Desktop / the Docker daemon, or point DOCKER_HOST at a remote daemon.',
    };
  }
  return { available: true, reason: '' };
}

const probe = probeAvailability();

const SKIP_MESSAGE =
  'e2e: testcontainers harness — SKIPPED. ' +
  'What is needed to run it:\n' +
  '  1. Install the dependency: pnpm --filter @ems/api add -D testcontainers @testcontainers/postgresql\n' +
  '  2. Start a Docker daemon (Docker Desktop, or dockerd on Linux; /var/run/docker.sock must exist\n' +
  '     or DOCKER_HOST must point at a daemon)\n' +
  '  3. Run: cd apps/api && npx jest --config ./test/jest-e2e.json testcontainers-harness\n' +
  'Until then the suite stays green-by-skip by design (same contract as the other e2e specs).';

(probe.available ? describe : describe.skip)('e2e: testcontainers harness (real Postgres)', () => {
  let app: INestApplication;
  let prisma: any;
  let container: any;
  let base: any; // supertest agent

  const tag = `tc-${Date.now()}`;

  beforeAll(async () => {
    // Lazy require: the package is absent in environments where we skip.
    let PostgreSqlContainer: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ PostgreSqlContainer } = require('testcontainers'));
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ PostgreSqlContainer } = require('@testcontainers/postgresql'));
    }

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const dbUrl: string = container.getConnectionUri();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
    process.env.DOCUMENT_ENCRYPTION_KEY = 'e2e-test-document-encryption-key-32b!!';

    // Migrate + seed the containerised database.
    const migrate = spawnSync(
      'pnpm',
      ['--filter', '@ems/database', 'prisma', 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: 'utf8' },
    );
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
    }
    const seed = spawnSync('pnpm', ['--filter', '@ems/database', 'prisma', 'db', 'seed'], {
      env: { ...process.env, DATABASE_URL: dbUrl },
      encoding: 'utf8',
    });
    if (seed.status !== 0) {
      throw new Error(`prisma db seed failed:\n${seed.stdout}\n${seed.stderr}`);
    }

    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    const { PrismaService } = require('../src/core/prisma/prisma.service');
    prisma = app.get(PrismaService);
    base = request(app.getHttpServer());

    // Seed two real users: an HR_ADMIN (inviter) and an EMPLOYEE (wrong-role
    // principal). Seeded users — not synthetic tokens — so the 403 assertions
    // below exercise the full guard chain including any DB-backed checks.
    const mkUser = (email: string, roles: string[]): Promise<any> =>
      prisma.user.create({
        data: {
          email,
          passwordHash: 'e2e-not-a-real-hash',
          emailVerified: true,
          isActive: true,
          roles: { create: roles.map((r) => ({ role: { connect: { name: r } } })) } as any,
        },
      });
    await mkUser(`tc-hr-${tag}@ems.local`, ['HR_ADMIN']);
    await mkUser(`tc-employee-${tag}@ems.local`, ['EMPLOYEE']);
  }, 180000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await base.post('/api/v1/auth/login').send({ email, password });
    if (res.status !== 200 || !res.body?.accessToken) {
      throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.accessToken as string;
  }

  describe('route-by-role matrix at HTTP level', () => {
    it('401 for unauthenticated access to a protected route', async () => {
      const res = await base.get('/api/v1/employees/some-id').send();
      expect(res.status).toBe(401);
    });

    it('403 for a seeded EMPLOYEE on an HR-only route', async () => {
      // Seed a real password so the login path is exercised end to end.
      const { PasswordService } = require('../src/modules/auth/password.service');
      const passwordService: any = app.get(PasswordService);
      const pwHash = await passwordService.hash('Tc-Password-1!');
      await prisma.user.update({
        where: { email: `tc-employee-${tag}@ems.local` },
        data: { passwordHash: pwHash },
      });
      const token = await login(`tc-employee-${tag}@ems.local`, 'Tc-Password-1!');

      const res = await base
        .post('/api/v1/payroll/runs/some-id/disburse')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      // 403 = authenticated but forbidden (404 would mean the route is wrong).
      expect(res.status).toBe(403);
    });

    it('public auth routes are not auth-walled', async () => {
      const res = await base.post('/api/v1/auth/login').send({});
      expect(res.status).not.toBe(401);
    });
  });

  describe('invitation -> accept -> login flow', () => {
    it('accepts a seeded invitation over HTTP and logs in with the new credentials', async () => {
      // Seed the invitation directly with a KNOWN raw token (the raw token
      // normally travels by email; hashing it here mirrors the service).
      // Route: POST /api/v1/auth/invitations/accept (controller base 'auth/invitations').
      const crypto = require('crypto') as typeof import('crypto');
      const rawToken = `tc-raw-${tag}`;
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const inviteEmail = `tc-invitee-${tag}@ems.local`;
      await prisma.invitation.create({
        data: {
          email: inviteEmail,
          tokenHash,
          role: 'EMPLOYEE',
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          createdById: (await prisma.user.findUnique({ where: { email: `tc-hr-${tag}@ems.local` } })).id,
        },
      });

      const accept = await base.post('/api/v1/auth/invitations/accept').send({
        token: rawToken,
        password: 'Tc-Invitee-Password-1!',
        firstName: 'Tc',
        lastName: 'Invitee',
      });
      expect(accept.status).toBeLessThan(300);

      const inviteeToken = await login(inviteEmail, 'Tc-Invitee-Password-1!');
      expect(typeof inviteeToken).toBe('string');

      // The invitation is single-use: a second accept is rejected.
      const replay = await base.post('/api/v1/auth/invitations/accept').send({
        token: rawToken,
        password: 'Tc-Invitee-Password-1!',
        firstName: 'Tc',
        lastName: 'Invitee',
      });
      expect(replay.status).toBeGreaterThanOrEqual(400);
    });
  });
});

if (!probe.available) {
  describe('e2e: testcontainers harness (real Postgres)', () => {
    it('skipped: testcontainers/Docker unavailable', () => {
      // eslint-disable-next-line no-console
      console.log(SKIP_MESSAGE);
      expect(probe.reason.length).toBeGreaterThan(0);
    });
  });
}
