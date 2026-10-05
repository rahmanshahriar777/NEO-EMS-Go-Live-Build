/**
 * E2E: concurrency invariants (double-approve race, duplicate-run idempotency).
 *
 * Fires genuinely concurrent HTTP requests against a REAL database and
 * asserts at-most-once semantics:
 *   1. double-approve race: two concurrent PATCH .../approve on the same
 *      DRAFT leave request -> exactly one succeeds (200), the other is
 *      rejected (400/409/403), and exactly one approval row exists;
 *   2. duplicate payroll-run creation: two concurrent POST /payroll/runs for
 *      the same period -> exactly one 201, the other 409, and exactly one
 *      run row exists.
 *
 * KNOWN LIMITATION (documented, not hidden): the current approve
 * implementations read-then-write inside a transaction without a row-level
 * lock or conditional update. Under a real race both requests can observe
 * the pre-approval state and both succeed. If this spec fails on (1), the
 * fix is a conditional update (`updateMany({ where: { id, status: DRAFT } })`
 * and asserting the affected-row count is 1) — the spec is the regression
 * net for that fix.
 *
 * Requires: Postgres reachable at E2E_DATABASE_URL (or DATABASE_URL) with
 * the Prisma schema migrated AND the base seed applied (roles/permissions).
 * Skips gracefully otherwise (see test/README.md).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
// AppModule is required lazily inside beforeAll (not statically imported)
// so a type error in another in-progress file within the module graph
// cannot break e2e compilation. At runtime require() executes the real
// module; type errors never block runtime.
import { PrismaService } from '../src/core/prisma/prisma.service';
import { e2eDbOrSkip } from './e2e-utils';

const gate = e2eDbOrSkip('concurrency');

(gate.available ? describe : describe.skip)('e2e: concurrency invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let config: ConfigService;

  let leaveTypeId: string;
  let managerToken: string;
  let hrToken: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = gate.target!.url;
    process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';

    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    config = app.get(ConfigService);

    const tag = `e2e-${Date.now()}`;
    const lt = await prisma.leaveType.create({
      data: {
        name: `E2E Concurrency ${tag}`,
        code: `EC${Date.now().toString(36).toUpperCase()}`,
        type: 'ANNUAL',
        defaultDaysPerYear: 25,
        isPaid: true,
      },
    });
    leaveTypeId = lt.id;

    // Seed payloads are `any`: the e2e suite targets a migrated schema and
    // must not break on field renames (e.g. isEmailVerified -> emailVerified).
    const mkUser = (email: string, roles: string[]): Promise<any> =>
      prisma.user.create({
        data: {
          email,
          passwordHash: 'e2e-not-a-real-hash',
          emailVerified: true,
          isActive: true,
          roles: { create: roles.map((r) => ({ role: { connect: { name: r } } })) } as any, // RoleWhereUniqueInput shape drifts with the schema; e2e seed only
        },
      });

    const managerUser = await mkUser(`e2e-conc-mgr-${tag}@ems.local`, ['MANAGER']);
    const hrUser = await mkUser(`e2e-conc-hr-${tag}@ems.local`, ['HR_ADMIN']);

    const managerEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'ConcMgr',
        email: `e2e-conc-mgr-${tag}@ems.local`,
        employeeNumber: `E2ECM${tag}`,
        status: 'FULL_TIME',
        userId: managerUser.id,
      },
    });
    const hrEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'ConcHr',
        email: `e2e-conc-hr-${tag}@ems.local`,
        employeeNumber: `E2ECH${tag}`,
        status: 'FULL_TIME',
        userId: hrUser.id,
      },
    });

    const sign = (sub: string, email: string, employeeId: string, roles: string[]) =>
      jwt.sign({ sub, email, roles, permissions: [], employeeId }, {
        secret: config.get<string>('jwt.accessSecret'),
        expiresIn: '15m',
      });
    managerToken = sign(managerUser.id, managerUser.email, managerEmp.id, ['MANAGER']);
    hrToken = sign(hrUser.id, hrUser.email, hrEmp.id, ['HR_ADMIN']);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  it('double-approve race: at most one approval wins', async () => {
    // Fresh requester whose manager is our MANAGER principal.
    const tag = `race-${Date.now()}`;
    const reqUser: any = await prisma.user.create({
      data: {
        email: `e2e-race-emp-${tag}@ems.local`,
        passwordHash: 'e2e-not-a-real-hash',
        emailVerified: true,
        isActive: true,
        roles: { create: [{ role: { connect: { name: 'EMPLOYEE' } } }] },
      } as any, // schema-drift tolerant seed payload (see mkUser note)
    });
    const mgrEmp = await prisma.employee.findFirst({
      where: { email: { contains: 'e2e-conc-mgr-' } },
      orderBy: { createdAt: 'desc' },
    });
    const reqEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'Racer',
        email: `e2e-race-emp-${tag}@ems.local`,
        employeeNumber: `E2ER${tag}`,
        status: 'FULL_TIME',
        userId: reqUser.id,
        managerId: mgrEmp!.id,
      },
    });
    const reqToken = jwt.sign(
      { sub: reqUser.id, email: reqUser.email, roles: ['EMPLOYEE'], permissions: [], employeeId: reqEmp.id },
      { secret: config.get<string>('jwt.accessSecret'), expiresIn: '15m' },
    );

    const created = await api()
      .post('/api/v1/leave-requests')
      .set('Authorization', `Bearer ${reqToken}`)
      .send({ leaveTypeId, startDate: '2027-08-02', endDate: '2027-08-03', reason: 'race' });
    expect(created.status).toBe(201);
    const requestId = created.body.id ?? created.body.data?.id;

    // Fire two approvals with no sequencing between them.
    const [a, b] = await Promise.all([
      api().patch(`/api/v1/leave-requests/${requestId}/approve`).set('Authorization', `Bearer ${managerToken}`).send({}),
      api().patch(`/api/v1/leave-requests/${requestId}/approve`).set('Authorization', `Bearer ${hrToken}`).send({}),
    ]);

    const okCount = [a, b].filter((r) => r.status === 200).length;
    expect(okCount).toBe(1);

    const approvals = await prisma.leaveApproval.count({ where: { leaveRequestId: requestId } });
    expect(approvals).toBe(1);
  });

  it('duplicate payroll-run creation race: exactly one run wins', async () => {
    // Seed one eligible employee with a salary structure so run creation
    // reaches the insert (not the "no eligible employees" 400).
    const tag = `pay-${Date.now()}`;
    const ss = await prisma.salaryStructure.create({
      data: { name: `E2E SS ${tag}`, currency: 'GBP', components: { create: [] } },
    });
    const emp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'Payroll',
        email: `e2e-pay-${tag}@ems.local`,
        employeeNumber: `E2EP${tag}`,
        status: 'FULL_TIME',
      },
    });
    await prisma.employeeSalaryStructure.create({
      data: {
        employeeId: emp.id,
        salaryStructureId: ss.id,
        baseSalary: 4000,
        effectiveFrom: new Date('2027-01-01'),
        isActive: true,
      },
    });

    const period = { month: 3, year: 2027 };
    const [a, b] = await Promise.all([
      api().post('/api/v1/payroll/runs').set('Authorization', `Bearer ${hrToken}`).send(period),
      api().post('/api/v1/payroll/runs').set('Authorization', `Bearer ${hrToken}`).send(period),
    ]);

    const created = [a, b].filter((r) => r.status === 201);
    const conflicted = [a, b].filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const runs = await prisma.payrollRun.count({
      where: { month: period.month, year: period.year },
    });
    expect(runs).toBe(1);
  });
});

if (!gate.available) {
  describe('e2e: concurrency invariants', () => {
    gate.registerSkip();
  });
}
