import { Test, TestingModule } from '@nestjs/testing';
import {
  RosteringService,
  computeOvertime,
  weekRangeMonday,
  DAILY_OVERTIME_THRESHOLD_MINUTES,
  WEEKLY_OVERTIME_THRESHOLD_MINUTES,
} from './rostering.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JwtPayload, SystemRole } from '@ems/shared';

const employeeViewer = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'employee@example.com',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

const managerViewer = (): JwtPayload => ({
  sub: 'mgr-1',
  email: 'manager@example.com',
  roles: [SystemRole.MANAGER],
  permissions: [],
  employeeId: 'emp-mgr',
});

const at = (iso: string) => new Date(iso);

describe('overtime math (pure functions)', () => {
  it('exposes the documented thresholds: 8h/day, 40h/week', () => {
    expect(DAILY_OVERTIME_THRESHOLD_MINUTES).toBe(480);
    expect(WEEKLY_OVERTIME_THRESHOLD_MINUTES).toBe(2400);
  });

  it('exactly 8h with a 40h week is NOT overtime', () => {
    const result = computeOvertime(at('2026-10-05T08:00:00Z'), at('2026-10-05T16:00:00Z'), 2400);
    expect(result).toEqual({ hoursWorked: 8, overtimeMinutes: 0, overtime: false });
  });

  it('8h + 1 minute breaches the daily threshold', () => {
    const result = computeOvertime(at('2026-10-05T08:00:00Z'), at('2026-10-05T16:01:00Z'), 2400);
    expect(result.overtimeMinutes).toBe(1);
    expect(result.overtime).toBe(true);
    expect(result.hoursWorked).toBeCloseTo(8.02, 2);
  });

  it('a 40h week total is NOT overtime even across entries', () => {
    // Five 8h days = exactly 40h.
    const result = computeOvertime(at('2026-10-09T08:00:00Z'), at('2026-10-09T16:00:00Z'), 2400);
    expect(result.overtime).toBe(false);
  });

  it('a week total of 40h + 1 minute IS overtime on an otherwise normal entry', () => {
    const result = computeOvertime(at('2026-10-09T08:00:00Z'), at('2026-10-09T16:00:00Z'), 2401);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.overtime).toBe(true);
  });

  it('rounds hoursWorked to 2dp', () => {
    const result = computeOvertime(at('2026-10-05T08:00:00Z'), at('2026-10-05T16:30:00Z'), 510);
    expect(result.hoursWorked).toBe(8.5);
    expect(result.overtimeMinutes).toBe(30);
  });
});

describe('weekRangeMonday', () => {
  it('starts the week on Monday (2026-10-04 is a Sunday)', () => {
    const { weekStart, weekEnd } = weekRangeMonday(at('2026-10-04T12:00:00Z'));
    expect(weekStart.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(weekEnd.toISOString()).toBe('2026-10-04T23:59:59.999Z');
  });

  it('a Monday maps to itself', () => {
    const { weekStart } = weekRangeMonday(at('2026-10-05T12:00:00Z'));
    expect(weekStart.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('RosteringService', () => {
  let service: RosteringService;
  let prisma: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      rosterEntry: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      employee: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((promises: Promise<any>[]) => Promise.all(promises)),
    };
    auditService = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RosteringService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<RosteringService>(RosteringService);
  });

  const entryRow = (overrides: Record<string, any> = {}) => ({
    id: 're-1',
    employeeId: 'emp-1',
    date: at('2026-10-05T00:00:00.000Z'),
    shiftName: 'Morning',
    startTime: at('2026-10-05T08:00:00.000Z'),
    endTime: at('2026-10-05T16:00:00.000Z'),
    notes: null,
    createdById: 'mgr-1',
    createdAt: at('2026-10-01T00:00:00.000Z'),
    employee: { id: 'emp-1', firstName: 'Jane', lastName: 'Doe', employeeNumber: 'EMP-1' },
    ...overrides,
  });

  describe('create', () => {
    it('rejects endTime before startTime', async () => {
      await expect(
        service.create(
          {
            employeeId: 'emp-1',
            date: '2026-10-05',
            startTime: '2026-10-05T16:00:00.000Z',
            endTime: '2026-10-05T08:00:00.000Z',
          },
          managerViewer(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rosterEntry.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown employee', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);

      await expect(
        service.create(
          {
            employeeId: 'nope',
            date: '2026-10-05',
            startTime: '2026-10-05T08:00:00.000Z',
            endTime: '2026-10-05T16:00:00.000Z',
          },
          managerViewer(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates the entry and attaches overtime info', async () => {
      prisma.employee.findFirst.mockResolvedValue({ id: 'emp-1', deletedAt: null });
      prisma.rosterEntry.create.mockResolvedValue(entryRow());
      // week-total lookup: only this one 8h entry in the week
      prisma.rosterEntry.findMany.mockResolvedValue([
        { startTime: entryRow().startTime, endTime: entryRow().endTime },
      ]);

      const result = await service.create(
        {
          employeeId: 'emp-1',
          date: '2026-10-05',
          startTime: '2026-10-05T08:00:00.000Z',
          endTime: '2026-10-05T16:00:00.000Z',
        },
        managerViewer(),
      );

      expect(prisma.rosterEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employeeId: 'emp-1', createdById: 'mgr-1' }),
        }),
      );
      expect(result).toMatchObject({ hoursWorked: 8, overtimeMinutes: 0, overtime: false });
    });
  });

  describe('findAllScoped', () => {
    it('restricts plain employees to their own entries', async () => {
      prisma.rosterEntry.count.mockResolvedValue(0);
      prisma.rosterEntry.findMany.mockResolvedValue([]);

      await service.findAllScoped({}, employeeViewer());

      expect(prisma.rosterEntry.count).toHaveBeenCalledWith({
        where: { employeeId: { in: ['emp-1'] } },
      });
    });

    it('rejects an employeeId filter outside the viewer scope', async () => {
      await expect(
        service.findAllScoped({ employeeId: 'emp-999' }, employeeViewer()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets managers see their direct reports', async () => {
      prisma.employee.findMany.mockResolvedValue([{ id: 'emp-9' }]);
      prisma.rosterEntry.count.mockResolvedValue(0);
      prisma.rosterEntry.findMany.mockResolvedValue([]);

      await service.findAllScoped({}, managerViewer());

      expect(prisma.rosterEntry.count).toHaveBeenCalledWith({
        where: { employeeId: { in: ['emp-mgr', 'emp-9'] } },
      });
    });

    it('flags weekly overtime in list responses', async () => {
      prisma.rosterEntry.count.mockResolvedValue(1);
      prisma.rosterEntry.findMany
        // page query
        .mockResolvedValueOnce([entryRow()])
        // week-total query: six 8h entries = 48h week
        .mockResolvedValue(
          Array.from({ length: 6 }, () => ({
            startTime: at('2026-10-05T08:00:00.000Z'),
            endTime: at('2026-10-05T16:00:00.000Z'),
          })),
        );

      const result = await service.findAllScoped({}, employeeViewer());

      expect(result.data[0]).toMatchObject({ overtime: true, overtimeMinutes: 0 });
      expect(result.meta).toEqual({ page: 1, limit: 20, total: 1 });
    });
  });

  describe('findOneScoped', () => {
    it('forbids a peer from viewing another employee entry', async () => {
      prisma.rosterEntry.findUnique.mockResolvedValue(entryRow({ employeeId: 'emp-2' }));

      await expect(service.findOneScoped('re-1', employeeViewer())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404s on unknown id', async () => {
      prisma.rosterEntry.findUnique.mockResolvedValue(null);

      await expect(service.findOneScoped('nope', employeeViewer())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update / remove', () => {
    it('update validates swapped times', async () => {
      prisma.rosterEntry.findUnique.mockResolvedValue(entryRow());

      await expect(
        service.update(
          're-1',
          { startTime: '2026-10-05T18:00:00.000Z', endTime: '2026-10-05T08:00:00.000Z' },
          managerViewer(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rosterEntry.update).not.toHaveBeenCalled();
    });

    it('remove hard-deletes and audit-logs (roster data is operational, not statutory)', async () => {
      prisma.rosterEntry.findUnique.mockResolvedValue(entryRow());
      prisma.rosterEntry.delete.mockResolvedValue(entryRow());

      const result = await service.remove('re-1', managerViewer());

      expect(prisma.rosterEntry.delete).toHaveBeenCalledWith({ where: { id: 're-1' } });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', entityType: 'RosterEntry' }),
      );
      expect(result).toEqual({ deleted: true, id: 're-1' });
    });
  });
});
