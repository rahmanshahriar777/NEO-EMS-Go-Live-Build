import { EmployeesService } from './employees.service';
import { _resetSchemaCompatCache } from '../../core/prisma/schema-compat.util';

/**
 * v4 fixes #8 (leaver exit stamping) and #9 (contractStart defaults to
 * joiningDate) on the EmployeesService create/update/remove paths.
 *
 * Prisma is fully mocked; pickKnownColumns probes information_schema via
 * prisma.$queryRaw, so the mock reports the contract/termination columns as
 * migrated (they are — migration 20261005133000_reconcile_phase3).
 */
describe('EmployeesService contract dates (v4 #8/#9)', () => {
  let service: EmployeesService;
  let prisma: any;
  let audit: { log: jest.Mock };

  const COLUMNS = [
    'id',
    'employeeNumber',
    'firstName',
    'lastName',
    'email',
    'joiningDate',
    'status',
    'contractStart',
    'contractEnd',
    'terminationDate',
    'deletedAt',
  ];

  const existingEmployee = (overrides: Record<string, any> = {}) => ({
    id: 'emp-1',
    employeeNumber: 'EMP-2026-0001',
    firstName: 'Ayesha',
    lastName: 'Khan',
    email: 'ayesha.khan@ems.local',
    status: 'FULL_TIME',
    joiningDate: new Date('2026-01-05T00:00:00Z'),
    contractStart: null,
    contractEnd: null,
    terminationDate: null,
    department: null,
    designation: null,
    ...overrides,
  });

  beforeEach(() => {
    _resetSchemaCompatCache();
    prisma = {
      employee: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(existingEmployee()),
        create: jest.fn((args: any) => Promise.resolve({ id: 'emp-new', ...args.data })),
        update: jest.fn((args: any) => Promise.resolve({ id: 'emp-1', ...args.data })),
      },
      employeeEmploymentHistory: { create: jest.fn().mockResolvedValue({}) },
      // information_schema probe for pickKnownColumns (tagged-template call).
      $queryRaw: jest.fn().mockResolvedValue(COLUMNS.map((column_name) => ({ column_name }))),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: 7 }]),
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new EmployeesService(prisma, audit as any, {} as any, {} as any);
  });

  describe('create — contractStart defaults to joiningDate (v4 #9)', () => {
    const baseDto: any = {
      firstName: 'Ayesha',
      lastName: 'Khan',
      email: 'ayesha.khan@ems.local',
    };

    test('explicit joiningDate, no contractStart → contractStart == joiningDate', async () => {
      await service.create({ ...baseDto, joiningDate: '2026-10-15' });
      const data = prisma.employee.create.mock.calls[0][0].data;
      expect(data.joiningDate).toEqual(new Date('2026-10-15T00:00:00Z'));
      expect(data.contractStart).toEqual(new Date('2026-10-15T00:00:00Z'));
    });

    test('no joiningDate, no contractStart → both stamped together', async () => {
      await service.create({ ...baseDto });
      const data = prisma.employee.create.mock.calls[0][0].data;
      expect(data.joiningDate).toBeInstanceOf(Date);
      expect(data.contractStart).toEqual(data.joiningDate);
    });

    test('explicit contractStart is respected, never overwritten', async () => {
      await service.create({
        ...baseDto,
        joiningDate: '2026-10-15',
        contractStart: '2026-10-01',
      });
      const data = prisma.employee.create.mock.calls[0][0].data;
      expect(data.contractStart).toEqual(new Date('2026-10-01T00:00:00Z'));
    });
  });

  describe('update — exit transition stamps contractEnd/terminationDate (v4 #8)', () => {
    test('FULL_TIME → TERMINATED stamps both dates', async () => {
      const before = Date.now();
      await service.update('emp-1', { status: 'TERMINATED' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.status).toBe('TERMINATED');
      expect(data.contractEnd).toBeInstanceOf(Date);
      expect(data.terminationDate).toBeInstanceOf(Date);
      expect(data.contractEnd.getTime()).toBeGreaterThanOrEqual(before);
      expect(data.terminationDate.getTime()).toBeGreaterThanOrEqual(before);
    });

    test('FULL_TIME → RESIGNED stamps both dates', async () => {
      await service.update('emp-1', { status: 'RESIGNED' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.status).toBe('RESIGNED');
      expect(data.contractEnd).toBeInstanceOf(Date);
      expect(data.terminationDate).toBeInstanceOf(Date);
    });

    test('explicit contractEnd in the exit update wins (e.g. paid notice)', async () => {
      await service.update(
        'emp-1',
        { status: 'TERMINATED', contractEnd: '2026-11-30' } as any,
      );
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.contractEnd).toEqual(new Date('2026-11-30T00:00:00Z'));
      expect(data.terminationDate).toBeInstanceOf(Date);
    });

    test('already-recorded terminationDate is never overwritten', async () => {
      const stamped = new Date('2026-09-15T00:00:00Z');
      prisma.employee.findFirst.mockResolvedValue(
        existingEmployee({ terminationDate: stamped }),
      );
      await service.update('emp-1', { status: 'TERMINATED' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.terminationDate).toEqual(stamped);
    });

    test('re-classifying an exit (TERMINATED → RESIGNED) does not restamp', async () => {
      prisma.employee.findFirst.mockResolvedValue(
        existingEmployee({
          status: 'TERMINATED',
          terminationDate: new Date('2026-09-15T00:00:00Z'),
        }),
      );
      await service.update('emp-1', { status: 'RESIGNED' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      // Not a new exit: the update carries no date fields, so the stored
      // terminationDate survives untouched.
      expect(data.terminationDate).toBeUndefined();
      expect(data.contractEnd).toBeUndefined();
    });

    test('non-exit update does not stamp dates', async () => {
      await service.update('emp-1', { phone: '+8801' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.contractEnd).toBeUndefined();
      expect(data.terminationDate).toBeUndefined();
    });

    test('joiningDate set with no contractStart anywhere → contractStart defaulted (v4 #9)', async () => {
      await service.update('emp-1', { joiningDate: '2026-10-15' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.joiningDate).toEqual(new Date('2026-10-15T00:00:00Z'));
      expect(data.contractStart).toEqual(new Date('2026-10-15T00:00:00Z'));
    });

    test('existing contractStart is never overwritten by the joiningDate default', async () => {
      prisma.employee.findFirst.mockResolvedValue(
        existingEmployee({ contractStart: new Date('2026-01-05T00:00:00Z') }),
      );
      await service.update('emp-1', { joiningDate: '2026-10-15' } as any);
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.contractStart).toBeUndefined();
    });
  });

  describe('remove — deactivation stamps exit dates (v4 #8)', () => {
    test('soft-delete also records contractEnd/terminationDate', async () => {
      await service.remove('emp-1');
      const data = prisma.employee.update.mock.calls[0][0].data;
      expect(data.status).toBe('TERMINATED');
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.contractEnd).toBeInstanceOf(Date);
      expect(data.terminationDate).toBeInstanceOf(Date);
    });
  });
});
