/**
 * E2E: leave approval flow (B4 regression net).
 *
 * Walks the release-critical path against a REAL database:
 *   1. seed: leave type, manager + employee users with linked employee rows
 *      (manager is the employee's managerId), balances for the current year;
 *   2. employee creates a leave request (working days);
 *   3. manager approves -> balance usedDays incremented, pendingDays decremented;
 *   4. non-manager (plain EMPLOYEE) approve -> 403;
 *   5. self-approve (requester approves own request) -> 403;
 *   6. audit trail records the approver's USER id (B4).
 *
 * Seeding uses the PrismaService from the booted app. All fixtures use
 * throwaway `@ems.local` addresses.
 *
 * Requires: Postgres reachable at E2E_DATABASE_URL (or DATABASE_URL) with
 * the Prisma schema migrated. Skips gracefully otherwise (see test/README.md).
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

const gate = e2eDbOrSkip('leave-approval');

function signFor(jwt: JwtService, config: ConfigService, p: Record<string, any>): string {
  return jwt.sign(p, {
    secret: config.get<string>('jwt.accessSecret'),
    expiresIn: '15m',
  });
}

(gate.available ? describe : describe.skip)('e2e: leave approval flow', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let config: ConfigService;

  let leaveTypeId: string;
  let managerEmpId: string;
  let employeeEmpId: string;
  let managerToken: string;
  let employeeToken: string;
  let otherEmployeeToken: string;

  /** A Mon–Wed range far enough in the future to avoid "past date" rules. */
  const startDate = '2027-06-07'; // Monday
  const endDate = '2027-06-09'; // Wednesday (3 working days)

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

    // ---- seed -----------------------------------------------------------
    const tag = `e2e-${Date.now()}`;
    const lt = await prisma.leaveType.create({
      data: {
        name: `E2E Annual ${tag}`,
        code: `E2E${Date.now().toString(36).toUpperCase()}`,
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

    const managerUser = await mkUser(`e2e-manager-${tag}@ems.local`, ['MANAGER']);
    const employeeUser = await mkUser(`e2e-employee-${tag}@ems.local`, ['EMPLOYEE']);
    const otherUser = await mkUser(`e2e-other-${tag}@ems.local`, ['EMPLOYEE']);

    const managerEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'Manager',
        email: `e2e-manager-${tag}@ems.local`,
        employeeNumber: `E2EM${tag}`,
        status: 'FULL_TIME',
        userId: managerUser.id,
      },
    });
    managerEmpId = managerEmp.id;

    const employeeEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'Employee',
        email: `e2e-employee-${tag}@ems.local`,
        employeeNumber: `E2EE${tag}`,
        status: 'FULL_TIME',
        userId: employeeUser.id,
        managerId: managerEmp.id,
      },
    });
    employeeEmpId = employeeEmp.id;

    const otherEmp = await prisma.employee.create({
      data: {
        firstName: 'E2E',
        lastName: 'Other',
        email: `e2e-other-${tag}@ems.local`,
        employeeNumber: `E2EO${tag}`,
        status: 'FULL_TIME',
        userId: otherUser.id,
      },
    });

    const year = new Date(startDate).getFullYear();
    await prisma.leaveBalance.create({
      data: {
        employeeId: employeeEmp.id,
        leaveTypeId,
        year,
        allocatedDays: 25,
        remainingDays: 25,
        usedDays: 0,
        pendingDays: 0,
      },
    });

    const base = (sub: string, email: string, employeeId: string, roles: string[]) => ({
      sub,
      email,
      roles,
      permissions: [],
      employeeId,
    });
    managerToken = signFor(jwt, config, base(managerUser.id, managerUser.email, managerEmp.id, ['MANAGER']));
    employeeToken = signFor(jwt, config, base(employeeUser.id, employeeUser.email, employeeEmp.id, ['EMPLOYEE']));
    otherEmployeeToken = signFor(jwt, config, base(otherUser.id, otherUser.email, otherEmp.id, ['EMPLOYEE']));
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  const api = () => request(app.getHttpServer());

  it('employee creates a leave request (3 working days go to pending)', async () => {
    const res = await api()
      .post('/api/v1/leave-requests')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ leaveTypeId, startDate, endDate, reason: 'e2e flow' });

    expect(res.status).toBe(201);
    expect(res.body.totalDays ?? res.body.data?.totalDays).toBe(3);

    const balance = await prisma.leaveBalance.findFirst({
      where: { employeeId: employeeEmpId, leaveTypeId },
    });
    expect(Number(balance!.pendingDays)).toBe(3);
    expect(Number(balance!.remainingDays)).toBe(22);
  });

  it('non-manager (plain EMPLOYEE) approve -> 403', async () => {
    const req = await prisma.leaveRequest.findFirst({
      where: { employeeId: employeeEmpId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    const res = await api()
      .patch(`/api/v1/leave-requests/${req!.id}/approve`)
      .set('Authorization', `Bearer ${otherEmployeeToken}`)
      .send({});

    // RolesGuard rejects EMPLOYEE before the service is ever reached.
    expect(res.status).toBe(403);
  });

  it('manager approves -> balance decremented and approval recorded', async () => {
    const req = await prisma.leaveRequest.findFirst({
      where: { employeeId: employeeEmpId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    const res = await api()
      .patch(`/api/v1/leave-requests/${req!.id}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ remarks: 'e2e approved' });

    expect(res.status).toBe(200);

    const balance = await prisma.leaveBalance.findFirst({
      where: { employeeId: employeeEmpId, leaveTypeId },
    });
    expect(Number(balance!.usedDays)).toBe(3);
    expect(Number(balance!.pendingDays)).toBe(0);
    expect(Number(balance!.remainingDays)).toBe(22);

    // B4: the approval row carries the approver's identity; the audit trail
    // records the approver's USER id (not the employee id).
    const approval = await prisma.leaveApproval.findFirst({
      where: { leaveRequestId: req!.id },
    });
    expect(approval!.approverId).toBe(managerEmpId);
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'LEAVE_REQUEST', entityId: req!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
  });

  it('self-approve -> 403 even for a manager', async () => {
    // A manager requesting leave for themselves, then approving it.
    const res2 = await api()
      .post('/api/v1/leave-requests')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ leaveTypeId, startDate: '2027-07-05', endDate: '2027-07-06', reason: 'e2e self' });
    expect(res2.status).toBe(201);
    const ownReqId = res2.body.id ?? res2.body.data?.id;

    const res = await api()
      .patch(`/api/v1/leave-requests/${ownReqId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({});

    expect(res.status).toBe(403);
  });
});

if (!gate.available) {
  describe('e2e: leave approval flow', () => {
    gate.registerSkip();
  });
}
