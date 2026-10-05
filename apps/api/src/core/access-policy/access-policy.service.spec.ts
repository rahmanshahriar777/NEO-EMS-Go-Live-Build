import { Test, TestingModule } from '@nestjs/testing';
import { AccessPolicyService } from './access-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemRole } from '@ems/shared';

describe('AccessPolicyService', () => {
  let service: AccessPolicyService;
  let prisma: any;

  const viewer = (overrides: Record<string, any> = {}) => ({
    userId: 'user-1',
    roles: [SystemRole.EMPLOYEE],
    employeeId: 'emp-1',
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      employee: { findFirst: jest.fn(), findMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessPolicyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<AccessPolicyService>(AccessPolicyService);
  });

  it('allows HR_ADMIN and SUPER_ADMIN on any target', async () => {
    for (const role of [SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN]) {
      await expect(
        service.can(viewer({ roles: [role], employeeId: undefined }), 'emp-9', 'view'),
      ).resolves.toBe(true);
    }
  });

  it('allows self access', async () => {
    await expect(service.can(viewer(), 'emp-1', 'edit')).resolves.toBe(true);
  });

  it('allows a manager to act on a direct report', async () => {
    prisma.employee.findFirst.mockResolvedValue({ managerId: 'emp-1' });
    await expect(
      service.can(viewer({ roles: [SystemRole.MANAGER] }), 'emp-2', 'approve'),
    ).resolves.toBe(true);
    expect(prisma.employee.findFirst).toHaveBeenCalledWith({
      where: { id: 'emp-2', deletedAt: null },
      select: { managerId: true },
    });
  });

  it('denies a manager acting on a non-report', async () => {
    prisma.employee.findFirst.mockResolvedValue({ managerId: 'emp-9' });
    await expect(
      service.can(viewer({ roles: [SystemRole.MANAGER] }), 'emp-2', 'view'),
    ).resolves.toBe(false);
  });

  it('denies peers without the manager link', async () => {
    // Non-manager roles never get team access even if managerId matches.
    prisma.employee.findFirst.mockResolvedValue({ managerId: 'emp-1' });
    await expect(service.can(viewer(), 'emp-2', 'view')).resolves.toBe(false);
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
  });

  it('denies viewers with no linked employee profile', async () => {
    await expect(
      service.can(viewer({ employeeId: undefined }), 'emp-2', 'view'),
    ).resolves.toBe(false);
  });

  it('denies empty target ids', async () => {
    await expect(service.can(viewer(), '', 'view')).resolves.toBe(false);
  });

  it('filterAllowed keeps self + direct reports in one query', async () => {
    prisma.employee.findMany.mockResolvedValue([
      { id: 'emp-2', managerId: 'emp-1' },
      { id: 'emp-3', managerId: 'emp-9' },
    ]);
    const allowed = await service.filterAllowed(
      viewer({ roles: [SystemRole.MANAGER] }),
      ['emp-1', 'emp-2', 'emp-3'],
      'view',
    );
    expect(allowed).toEqual(['emp-1', 'emp-2']);
  });

  it('filterAllowed returns everything for HR', async () => {
    const allowed = await service.filterAllowed(
      viewer({ roles: [SystemRole.HR_ADMIN], employeeId: undefined }),
      ['a', 'b'],
      'view',
    );
    expect(allowed).toEqual(['a', 'b']);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });
});
