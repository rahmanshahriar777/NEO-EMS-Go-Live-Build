import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { SystemRole } from '@ems/shared';

/**
 * UsersService tests: safe projection (no passwordHash), pagination,
 * role replacement, and self-protection.
 */
describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;

  const row = (overrides: Record<string, any> = {}) => ({
    id: 'user-1',
    email: 'jane@ems.local',
    passwordHash: 'secret-hash',
    isActive: true,
    emailVerified: true,
    createdAt: new Date('2026-01-01'),
    roles: [{ role: { name: 'EMPLOYEE' } }],
    employee: {
      id: 'emp-1',
      firstName: 'Jane',
      lastName: 'Smith',
      employeeNumber: 'EMP-2026-0001',
    },
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      user: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([row()]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      role: { findMany: jest.fn() },
      userRole: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn((fn: any) => {
        // Track the last update so the re-read reflects it, like a real tx.
        let lastData: Record<string, any> = {};
        return fn({
          userRole: prisma.userRole,
          user: {
            update: jest.fn((args: any) => {
              lastData = args.data;
              return Promise.resolve(row({ ...args.data }));
            }),
            findUnique: jest.fn(() => Promise.resolve(row({ ...lastData }))),
          },
        });
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('listUsers returns the safe projection without passwordHash', async () => {
    const result = await service.listUsers(1, 50);

    expect(result.total).toBe(1);
    expect(result.data[0]).toEqual({
      id: 'user-1',
      email: 'jane@ems.local',
      isActive: true,
      emailVerified: true,
      roles: ['EMPLOYEE'],
      employee: {
        id: 'emp-1',
        firstName: 'Jane',
        lastName: 'Smith',
        employeeNumber: 'EMP-2026-0001',
      },
      createdAt: new Date('2026-01-01'),
    });
    expect(result.data[0]).not.toHaveProperty('passwordHash');
  });

  it('listUsers clamps pagination bounds', async () => {
    await service.listUsers(0, 5000);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
  });

  it('updateUser toggles flags', async () => {
    prisma.user.findUnique.mockResolvedValue(row());

    const updated = await service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'user-1', {
      isActive: false,
    });

    expect(updated.isActive).toBe(false);
  });

  it('updateUser replaces roles for SUPER_ADMIN callers', async () => {
    prisma.user.findUnique.mockResolvedValue(row());
    prisma.role.findMany.mockResolvedValue([{ id: 'role-hr', name: 'HR_ADMIN' }]);

    await service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'user-1', {
      roles: ['hr_admin'],
    });

    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(prisma.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', roleId: 'role-hr' }],
    });
  });

  it('updateUser rejects role changes from non-SUPER_ADMIN callers', async () => {
    prisma.user.findUnique.mockResolvedValue(row());

    await expect(
      service.updateUser('hr-1', [SystemRole.HR_ADMIN], 'user-1', { roles: ['MANAGER'] }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it('updateUser rejects invalid role names', async () => {
    prisma.user.findUnique.mockResolvedValue(row());

    await expect(
      service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'user-1', { roles: ['CEO'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('updateUser forbids self-deactivation and self role changes', async () => {
    prisma.user.findUnique.mockResolvedValue(row({ id: 'admin-1' }));

    await expect(
      service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'admin-1', { isActive: false }),
    ).rejects.toThrow(/yourself/i);
    await expect(
      service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'admin-1', { roles: ['EMPLOYEE'] }),
    ).rejects.toThrow(/yourself/i);
  });

  it('updateUser throws NotFoundException for unknown users', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.updateUser('admin-1', [SystemRole.SUPER_ADMIN], 'nope', { isActive: false }),
    ).rejects.toThrow(NotFoundException);
  });
});
