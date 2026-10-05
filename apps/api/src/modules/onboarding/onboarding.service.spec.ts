import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SystemRole } from '@ems/shared';

// The service probes information_schema for the onboarding tables; the mock
// pretends the migration has landed.
jest.mock('../../core/prisma/schema-compat.util', () => ({
  tableExists: jest.fn(async () => true),
  pickKnownColumns: jest.fn(async (_p: any, _t: string, d: any) => d),
}));

describe('OnboardingService', () => {
  let service: OnboardingService;
  let prisma: any;
  let notifications: any;

  const hr = { userId: 'user-hr', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] };
  const employee = { userId: 'user-1', employeeId: 'emp-1', roles: [SystemRole.EMPLOYEE] };

  beforeEach(async () => {
    prisma = {
      onboardingChecklist: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      onboardingTask: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
      employee: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    };
    notifications = { createNotification: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get<OnboardingService>(OnboardingService);
  });

  it('lets HR start an onboarding checklist with default tasks', async () => {
    prisma.onboardingChecklist.create.mockImplementation(async ({ data }: any) => ({
      id: 'cl-1',
      ...data,
      tasks: data.tasks.create.map((t: any, i: number) => ({ id: `t-${i}`, ...t })),
    }));
    prisma.employee.findUnique.mockResolvedValue({ userId: 'user-1' });

    const result: any = await service.createChecklist(
      { employeeId: 'emp-1', kind: 'ONBOARDING' } as any,
      hr,
    );

    expect(result.tasks).toHaveLength(6); // DEFAULT_ONBOARDING_TASKS
    expect(result.tasks[0].title).toBe('Sign employment contract');
    expect(notifications.createNotification).toHaveBeenCalled();
  });

  it('forbids non-HR from starting checklists', async () => {
    await expect(
      service.createChecklist({ employeeId: 'emp-1', kind: 'ONBOARDING' } as any, employee),
    ).rejects.toThrow(ForbiddenException);
  });

  it('scopes listChecklists to the caller\u2019s own employee for non-managers', async () => {
    prisma.onboardingChecklist.findMany.mockResolvedValue([]);
    await service.listChecklists(employee, undefined);
    expect(prisma.onboardingChecklist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: 'emp-1' } }),
    );
  });

  it('completes a task and flips the checklist to COMPLETED when all tasks are done', async () => {
    prisma.onboardingTask.findUnique.mockResolvedValue({
      id: 't-1',
      checklistId: 'cl-1',
      status: 'PENDING',
      title: 'Sign contract',
      checklist: { id: 'cl-1', employeeId: 'emp-1', status: 'IN_PROGRESS' },
    });
    prisma.onboardingTask.update.mockImplementation(async ({ data }: any) => ({ id: 't-1', ...data }));
    prisma.onboardingTask.count.mockResolvedValue(0);
    prisma.onboardingChecklist.update.mockResolvedValue({ id: 'cl-1', status: 'COMPLETED' });

    const result: any = await service.completeTask('t-1', {} as any, employee);

    expect(result.status).toBe('DONE');
    expect(result.checklistStatus).toBe('COMPLETED');
    expect(prisma.onboardingChecklist.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'COMPLETED' } }),
    );
  });

  it('forbids unrelated users from completing a task', async () => {
    prisma.onboardingTask.findUnique.mockResolvedValue({
      id: 't-1',
      checklistId: 'cl-1',
      status: 'PENDING',
      title: 'x',
      ownerUserId: 'user-9',
      checklist: { id: 'cl-1', employeeId: 'emp-9', status: 'IN_PROGRESS' },
    });
    await expect(service.completeTask('t-1', {} as any, employee)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('is idempotent when the task is already DONE', async () => {
    prisma.onboardingTask.findUnique.mockResolvedValue({
      id: 't-1',
      status: 'DONE',
      checklist: { id: 'cl-1', employeeId: 'emp-1' },
    });
    const result = await service.completeTask('t-1', {} as any, employee);
    expect(result.status).toBe('DONE');
    expect(prisma.onboardingTask.update).not.toHaveBeenCalled();
  });
});

describe('OnboardingService — unmigrated tables', () => {
  it('throws a named 503 when the migration has not landed', async () => {
    const { tableExists } = require('../../core/prisma/schema-compat.util');
    tableExists.mockResolvedValueOnce(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
      ],
    }).compile();
    const svc = module.get<OnboardingService>(OnboardingService);

    await expect(
      svc.createChecklist({ employeeId: 'emp-1', kind: 'ONBOARDING' } as any, {
        userId: 'u',
        roles: [SystemRole.HR_ADMIN],
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
