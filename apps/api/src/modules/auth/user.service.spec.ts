import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UserService } from './user.service';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * UserService: duplicate-email handling and sequence-backed employee numbers
 * (go-live HIGH #9 — the register path mints EMP-YYYY-NNNN via
 * employee_number_seq, never count()+1).
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
      employee: { create: jest.fn() },
      $queryRawUnsafe: jest.fn(),
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
    tx.$queryRawUnsafe.mockResolvedValue([{ n: 1001 }]);
    tx.employee.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'emp-1', ...data }),
    );

    const { user, employee } = await service.createUser(
      'Jane@Ems.Local',
      'hash',
      'Jane',
      'Smith',
    );

    expect(user.id).toBe('user-1');
    expect(employee.employeeNumber).toBe(`EMP-${new Date().getFullYear()}-1001`);
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

  it('mints the employee number from the shared sequence, never count()+1', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });
    tx.$queryRawUnsafe.mockResolvedValue([{ n: 1002 }]);
    tx.employee.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'emp-1', ...data }),
    );

    const { employee } = await service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith');

    // The register path must call the sequence helper (atomic nextval) —
    // the same contract as employees.service.create and the recruitment
    // offer-accept path. No count() probe, so concurrent signups and
    // soft-deleted employees' numbers can never collide.
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("nextval('employee_number_seq')"),
    );
    expect(employee.employeeNumber).toBe(`EMP-${new Date().getFullYear()}-1002`);
  });

  it('fails loud when the sequence is missing (never fabricates a number)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'user-1', email: 'jane@ems.local' });
    tx.$queryRawUnsafe.mockResolvedValue([]);

    await expect(service.createUser('jane@ems.local', 'hash', 'Jane', 'Smith')).rejects.toThrow(
      /employee_number_seq/,
    );
    expect(tx.employee.create).not.toHaveBeenCalled();
  });

  it('lowercases the email on lookup', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await service.findByEmail('JANE@EMS.LOCAL');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'jane@ems.local' }) }),
    );
  });
});
