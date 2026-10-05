import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserService } from './user.service';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * UserService: duplicate-email handling and the employee-number race retry.
 */
describe('UserService', () => {
  let service: UserService;
  let prisma: any;
  let tx: any;

  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    } as any);

  beforeEach(async () => {
    tx = {
      user: { create: jest.fn() },
      employee: { count: jest.fn(), create: jest.fn() },
    };
    prisma = {
      user: { findUnique: jest.fn() },
      role: { findMany: jest.fn().mockResolvedValue([{ id: 'role-1', name: 'EMPLOYEE' }]) },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    const module = await (await import('@nestjs/testing')).Test.createTestingModule({
      providers: [UserService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  it('creates a user and scaffolds the employee record', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });
    tx.employee.count.mockResolvedValue(0);
    tx.employee.create.mockResolvedValue({ id: 'emp-1', employeeNumber: 'EMP-2026-0001' });

    const { user, employee } = await service.createUser(
      'Jane@Ems.Local',
      'hash',
      'Jane',
      'Smith',
    );

    expect(user.id).toBe('user-1');
    expect(employee.employeeNumber).toMatch(/^EMP-\d{4}-0001$/);
    // Email is normalized before the uniqueness check and the write.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'jane@ems.local' } }),
    );
  });

  it('rejects a duplicate email with 409 (pre-check)', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith')).rejects.toThrow(
      ConflictException,
    );
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('converts a raced email insert (P2002) into a 409', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockRejectedValue(p2002(['email']));
    await expect(service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith')).rejects.toThrow(
      ConflictException,
    );
  });

  it('retries the employee insert on employeeNumber conflicts', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });
    tx.employee.count.mockResolvedValue(41);
    tx.employee.create
      .mockRejectedValueOnce(p2002(['employeeNumber']))
      .mockResolvedValue({ id: 'emp-1', employeeNumber: 'EMP-2026-0042' });

    const { employee } = await service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith');

    expect(tx.employee.create).toHaveBeenCalledTimes(2);
    expect(employee.employeeNumber).toBe('EMP-2026-0042');
  });

  it('gives up after the bounded retry attempts', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });
    tx.employee.count.mockResolvedValue(0);
    tx.employee.create.mockRejectedValue(p2002(['employeeNumber']));

    await expect(service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith')).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(tx.employee.create).toHaveBeenCalledTimes(5);
  });

  it('lowercases the email on lookup', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await service.findByEmail('JANE@EMS.LOCAL');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'jane@ems.local' }) }),
    );
  });
});
