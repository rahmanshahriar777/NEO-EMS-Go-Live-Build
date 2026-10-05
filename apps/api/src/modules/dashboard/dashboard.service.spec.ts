import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ACCESS_POLICY, LocalAccessPolicyService } from './access-policy';

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: any;

  const buildModule = async (viewer: { sub: string; employeeId?: string; roles: string[] }) => {
    prisma = {
      employee: { count: jest.fn().mockResolvedValue(10), groupBy: jest.fn().mockResolvedValue([]) },
      attendanceRecord: { groupBy: jest.fn().mockResolvedValue([]) },
      leaveRequest: { count: jest.fn().mockResolvedValue(0) },
      leaveBalance: { findMany: jest.fn().mockResolvedValue([]) },
      payrollRun: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: ACCESS_POLICY, useClass: LocalAccessPolicyService },
      ],
    }).compile();
    service = module.get<DashboardService>(DashboardService);
    return service.getKpis(viewer);
  };

  it('grants company scope to HR roles with full KPIs', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        {
          provide: PrismaService,
          useValue: {
            employee: {
              count: jest.fn().mockResolvedValue(42),
              groupBy: jest.fn().mockResolvedValue([{ status: 'FULL_TIME', _count: { status: 40 } }]),
            },
            attendanceRecord: {
              groupBy: jest.fn().mockResolvedValue([
                { status: 'PRESENT', _count: { status: 30 } },
                { status: 'ABSENT', _count: { status: 2 } },
              ]),
            },
            leaveRequest: { count: jest.fn().mockResolvedValue(5) },
            leaveBalance: { findMany: jest.fn().mockResolvedValue([]) },
            payrollRun: {
              findFirst: jest.fn().mockResolvedValue({
                month: 9, year: 2026, status: 'PAID',
                totalGross: 100000, totalDeductions: 20000, totalNet: 80000,
                _count: { payslips: 42 },
              }),
            },
          },
        },
        { provide: ACCESS_POLICY, useClass: LocalAccessPolicyService },
      ],
    }).compile();
    service = module.get<DashboardService>(DashboardService);

    const kpis = await service.getKpis({ sub: 'hr-1', employeeId: 'emp-hr', roles: ['HR_ADMIN'] });

    expect(kpis.scope).toBe('company');
    expect(kpis.headcount?.total).toBe(42);
    expect(kpis.attendanceToday.present).toBe(30);
    expect(kpis.attendanceToday.absent).toBe(2);
    expect(kpis.pendingApprovals.total).toBe(5);
    expect(kpis.payrollCost?.totalNet).toBe(80000);
  });

  it('restricts managers to team scope and hides payroll cost', async () => {
    const kpis = await buildModule({ sub: 'mgr-1', employeeId: 'emp-mgr', roles: ['MANAGER'] });

    expect(kpis.scope).toBe('team');
    expect(kpis.headcount).toBeNull();
    expect(kpis.payrollCost).toBeNull();
    // team filter applied to pending approvals
    expect(prisma.leaveRequest.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ employee: { managerId: 'emp-mgr' } }) }),
    );
  });

  it('restricts plain employees to self scope', async () => {
    const kpis = await buildModule({ sub: 'emp-1', employeeId: 'emp-1', roles: ['EMPLOYEE'] });

    expect(kpis.scope).toBe('self');
    expect(kpis.headcount).toBeNull();
    expect(kpis.payrollCost).toBeNull();
    expect(prisma.leaveRequest.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ employeeId: 'emp-1' }) }),
    );
  });

  it('LocalAccessPolicyService fails closed for unknown callers', () => {
    const policy = new LocalAccessPolicyService();
    expect(policy.can({ userId: 'x', roles: [] }, null, 'dashboard:company')).toBe(false);
    expect(policy.can({ userId: 'x', roles: [] }, null, 'dashboard:team')).toBe(false);
    expect(policy.can({ userId: 'x', roles: [] }, null, 'dashboard:self')).toBe(false);
    expect(policy.can({ userId: 'x', roles: ['MANAGER'] }, null, 'dashboard:team')).toBe(false);
    expect(
      policy.can({ userId: 'x', employeeId: 'e1', roles: ['MANAGER'] }, null, 'dashboard:team'),
    ).toBe(true);
  });
});
