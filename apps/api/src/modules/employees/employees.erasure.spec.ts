import { Test, TestingModule } from '@nestjs/testing';
import { EmployeesService } from './employees.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { AvatarStorageService } from '../../core/storage/avatar-storage.service';

jest.mock('../../core/prisma/schema-compat.util', () => ({
  tableExists: jest.fn(async () => true),
  hasColumn: jest.fn(async () => true),
  pickKnownColumns: jest.fn(async (_p: any, _t: string, d: any) => d),
}));

describe('EmployeesService.anonymizeEmployee — erasure inventory', () => {
  let service: EmployeesService;
  let prisma: any;

  const updateMany = () => ({ updateMany: jest.fn(async () => ({ count: 2 })) });

  beforeEach(async () => {
    const tx: any = {
      employee: { update: jest.fn(async () => ({})) },
      user: { update: jest.fn(async () => ({})) },
      document: updateMany(),
      aIRequestLog: updateMany(),
      notification: updateMany(),
      loginAuditLog: updateMany(),
      goal: updateMany(),
      feedback: updateMany(),
      performanceReview: updateMany(),
      rosterEntry: updateMany(),
    };

    prisma = {
      employee: {
        findFirst: jest.fn(async () => ({
          id: 'emp-1',
          email: 'ada@example.com',
          user: { id: 'user-1', email: 'ada@example.com' },
          _count: { payslips: 3, salaryStructures: 1, attendance: 40, leaveRequests: 5 },
        })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    // expose tx for assertions
    (prisma as any).__tx = tx;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn(async () => ({})) } },
        { provide: AccessPolicyService, useValue: { can: jest.fn() } },
        {
          provide: AvatarStorageService,
          useValue: {
            getAvatarUrl: jest.fn(async (v: string) => v),
            uploadAvatar: jest.fn(async () => ({ key: 'avatars/x/y.png' })),
            deleteAvatar: jest.fn(async () => undefined),
          },
        },
      ],
    }).compile();
    service = module.get<EmployeesService>(EmployeesService);
  });

  it('scrubs PII-bearing free text in non-statutory rows and reports the inventory', async () => {
    const result: any = await service.anonymizeEmployee('emp-1', 'hr-1', 'hr@ems.local');
    const tx = (prisma as any).__tx;

    // Document metadata scrubbed (rows retained).
    expect(tx.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeId: 'emp-1' }),
        data: { description: null },
      }),
    );
    // AI prompts/responses scrubbed.
    expect(tx.aIRequestLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    // Notifications scrubbed.
    expect(tx.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { recipientId: 'user-1' } }),
    );
    // Login-audit emails tokenised.
    expect(tx.loginAuditLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ emailAttempted: expect.stringMatching(/^redacted-/) }),
      }),
    );
    // Goals, feedback comments, self-review text, roster notes scrubbed.
    expect(tx.goal.updateMany).toHaveBeenCalled();
    expect(tx.feedback.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ senderId: 'emp-1' }, { recipientId: 'emp-1' }] },
      }),
    );
    expect(tx.performanceReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { selfAchievements: null, selfImprovements: null },
      }),
    );
    expect(tx.rosterEntry.updateMany).toHaveBeenCalled();

    // Inventory is part of the erasure evidence.
    expect(result.erasureInventory).toHaveProperty('documents');
    expect(result.erasureInventory).toHaveProperty('aiRequestLogs');
    expect(result.erasureInventory).toHaveProperty('notifications');
    expect(result.erasureInventory).toHaveProperty('loginAuditLogs');
    expect(result.erasureInventory).toHaveProperty('goals');
    expect(result.erasureInventory).toHaveProperty('feedback');
    expect(result.erasureInventory).toHaveProperty('performanceReviews');
    expect(result.erasureInventory).toHaveProperty('rosterNotes');
    for (const entry of Object.values(result.erasureInventory) as any[]) {
      expect(entry).toHaveProperty('scrubbed');
      expect(entry).toHaveProperty('retained');
      expect(entry).toHaveProperty('note');
    }
  });

  it('leaves statutory rows untouched (no writes to payslip/attendance/leave)', async () => {
    await service.anonymizeEmployee('emp-1', 'hr-1', 'hr@ems.local');
    const tx = (prisma as any).__tx;
    expect(tx).not.toHaveProperty('payslip');
    expect(tx).not.toHaveProperty('attendanceRecord');
    expect(tx).not.toHaveProperty('leaveRequest');
  });
});
