import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * RolesService tests: SUBJECT:ACTION parsing, grant replacement, and
 * system-role protection.
 */
describe('RolesService', () => {
  let service: RolesService;
  let prisma: any;

  const permissionRow = (subject: string, action: string) => ({
    id: `${subject}-${action}`,
    subject,
    action,
  });

  const roleRow = (overrides: Record<string, any> = {}) => ({
    id: 'role-1',
    name: 'HR_ADMIN',
    description: 'HR admin',
    isSystem: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    permissions: [
      { permission: permissionRow('LEAVE', 'READ') },
      { permission: permissionRow('LEAVE', 'APPROVE') },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      role: {
        findMany: jest.fn().mockResolvedValue([roleRow()]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn((args: any) => Promise.resolve({ id: 'role-new', ...args.data, permissions: [] })),
        update: jest.fn(),
        delete: jest.fn(),
      },
      permission: { findMany: jest.fn() },
      rolePermission: { deleteMany: jest.fn(), createMany: jest.fn() },
      $transaction: jest.fn((fn: any) =>
        fn({
          rolePermission: prisma.rolePermission,
          role: {
            update: jest.fn((args: any) =>
              Promise.resolve(roleRow({ description: args.data.description })),
            ),
          },
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RolesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  it('listRoles returns permissions in SUBJECT:ACTION format', async () => {
    const roles = await service.listRoles();

    expect(roles[0].permissions).toEqual(['LEAVE:READ', 'LEAVE:APPROVE']);
  });

  it('listPermissions returns SUBJECT:ACTION strings sorted by subject', async () => {
    prisma.permission.findMany.mockResolvedValue([
      permissionRow('LEAVE', 'READ'),
      permissionRow('USER', 'CREATE'),
    ]);

    const permissions = await service.listPermissions();

    expect(permissions).toEqual(['LEAVE:READ', 'USER:CREATE']);
  });

  it('createRole grants resolved permissions', async () => {
    prisma.role.findFirst.mockResolvedValue(null);
    prisma.permission.findMany.mockResolvedValue([
      permissionRow('PAYROLL', 'READ'),
      permissionRow('PAYROLL', 'APPROVE'),
    ]);

    const role = await service.createRole({
      name: 'payroll_manager',
      permissions: ['payroll:read', 'PAYROLL:APPROVE'],
    });

    expect(role.name).toBe('payroll_manager');
    expect(prisma.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSystem: false }),
      }),
    );
    const perms = prisma.role.create.mock.calls[0][0].data.permissions.create;
    expect(perms).toEqual([
      { permissionId: 'PAYROLL-READ' },
      { permissionId: 'PAYROLL-APPROVE' },
    ]);
  });

  it('createRole rejects duplicate names', async () => {
    prisma.role.findFirst.mockResolvedValue(roleRow());

    await expect(service.createRole({ name: 'HR_ADMIN' })).rejects.toThrow(ConflictException);
  });

  it('createRole rejects malformed permission strings', async () => {
    prisma.role.findFirst.mockResolvedValue(null);

    await expect(service.createRole({ name: 'X', permissions: ['NOPE'] })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.createRole({ name: 'X', permissions: ['A:B:C'] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('createRole rejects unknown permissions', async () => {
    prisma.role.findFirst.mockResolvedValue(null);
    prisma.permission.findMany.mockResolvedValue([permissionRow('PAYROLL', 'READ')]);

    await expect(
      service.createRole({ name: 'X', permissions: ['PAYROLL:READ', 'PAYROLL:DELETE'] }),
    ).rejects.toThrow(/unknown permissions/i);
  });

  it('updateRole replaces the grant set', async () => {
    prisma.role.findUnique.mockResolvedValue(roleRow({ id: 'role-1', isSystem: false }));
    prisma.permission.findMany.mockResolvedValue([permissionRow('USER', 'READ')]);

    await service.updateRole('role-1', { permissions: ['USER:READ'] });

    expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-1' } });
    expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'role-1', permissionId: 'USER-READ' }],
    });
  });

  it('updateRole throws NotFoundException for unknown ids', async () => {
    prisma.role.findUnique.mockResolvedValue(null);

    await expect(service.updateRole('nope', {})).rejects.toThrow(NotFoundException);
  });

  it('deleteRole protects system roles', async () => {
    prisma.role.findUnique.mockResolvedValue(roleRow({ isSystem: true, users: [] }));

    await expect(service.deleteRole('role-1')).rejects.toThrow(/system roles/i);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('deleteRole refuses roles still assigned to users', async () => {
    prisma.role.findUnique.mockResolvedValue(roleRow({ isSystem: false, users: [{ id: 'u' }] }));

    await expect(service.deleteRole('role-1')).rejects.toThrow(/assigned to 1 user/i);
  });

  it('deleteRole deletes an unused custom role', async () => {
    prisma.role.findUnique.mockResolvedValue(roleRow({ isSystem: false, users: [] }));

    await service.deleteRole('role-1');

    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
  });
});
