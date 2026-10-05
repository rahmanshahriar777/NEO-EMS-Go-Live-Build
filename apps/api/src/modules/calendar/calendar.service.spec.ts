import { Test, TestingModule } from '@nestjs/testing';
import { CalendarService } from './calendar.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { JwtPayload, SystemRole } from '@ems/shared';

const employeeViewer = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'employee@example.com',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

const hrViewer = (): JwtPayload => ({
  sub: 'hr-1',
  email: 'hr@example.com',
  roles: [SystemRole.HR_ADMIN],
  permissions: [],
  employeeId: 'emp-hr',
});

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T00:00:00.000Z');

describe('CalendarService', () => {
  let service: CalendarService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      leaveRequest: { findMany: jest.fn().mockResolvedValue([]) },
      holiday: { findMany: jest.fn().mockResolvedValue([]) },
      rosterEntry: { findMany: jest.fn().mockResolvedValue([]) },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CalendarService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<CalendarService>(CalendarService);
  });

  describe('getEvents', () => {
    const approvedLeave = {
      id: 'leave-1',
      employeeId: 'emp-2',
      startDate: new Date('2026-10-10T00:00:00.000Z'),
      endDate: new Date('2026-10-12T00:00:00.000Z'),
      employee: { id: 'emp-2', firstName: 'Jane', lastName: 'Doe' },
      leaveType: { name: 'Annual' },
    };

    it('queries only APPROVED leave requests overlapping the range', async () => {
      await service.getEvents(FROM, TO, employeeViewer());

      expect(prisma.leaveRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'APPROVED',
            startDate: { lte: TO },
            endDate: { gte: FROM },
          }),
        }),
      );
    });

    it('shows a peer leave as anonymous "Busy" without an employeeId', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([approvedLeave]);

      const events = await service.getEvents(FROM, TO, employeeViewer());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: 'leave:leave-1', type: 'leave', title: 'Busy' });
      expect(events[0]).not.toHaveProperty('employeeId');
    });

    it('shows the employee name to HR/admin viewers', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([approvedLeave]);

      const events = await service.getEvents(FROM, TO, hrViewer());

      expect(events[0]).toMatchObject({
        type: 'leave',
        title: 'Jane Doe — Annual leave',
        employeeId: 'emp-2',
      });
    });

    it('shows the viewer their own leave with a name', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([
        { ...approvedLeave, employeeId: 'emp-1', employee: { id: 'emp-1', firstName: 'Me', lastName: 'Self' } },
      ]);

      const events = await service.getEvents(FROM, TO, employeeViewer());

      expect(events[0].title).toContain('Me Self');
      expect(events[0].employeeId).toBe('emp-1');
    });

    it('maps holidays to holiday events for every viewer', async () => {
      prisma.holiday.findMany.mockResolvedValue([
        { id: 'h-1', title: 'Independence Day', date: new Date('2026-10-05T00:00:00.000Z') },
      ]);

      const events = await service.getEvents(FROM, TO, employeeViewer());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'holiday:h-1',
        type: 'holiday',
        title: 'Independence Day',
      });
    });

    it('maps roster entries with their shift start/end times', async () => {
      prisma.rosterEntry.findMany.mockResolvedValue([
        {
          id: 'r-1',
          employeeId: 'emp-1',
          date: new Date('2026-10-06T00:00:00.000Z'),
          shiftName: 'Morning',
          startTime: new Date('2026-10-06T08:00:00.000Z'),
          endTime: new Date('2026-10-06T16:00:00.000Z'),
          employee: { id: 'emp-1', firstName: 'Me', lastName: 'Self' },
        },
      ]);

      const events = await service.getEvents(FROM, TO, employeeViewer());

      expect(events[0]).toMatchObject({
        id: 'roster:r-1',
        type: 'roster',
        start: '2026-10-06T08:00:00.000Z',
        end: '2026-10-06T16:00:00.000Z',
        employeeId: 'emp-1',
      });
    });

    it('returns events sorted by start time', async () => {
      prisma.leaveRequest.findMany.mockResolvedValue([approvedLeave]);
      prisma.holiday.findMany.mockResolvedValue([
        { id: 'h-1', title: 'Early', date: new Date('2026-10-02T00:00:00.000Z') },
      ]);

      const events = await service.getEvents(FROM, TO, employeeViewer());

      expect(events.map((e) => e.type)).toEqual(['holiday', 'leave']);
    });
  });

  describe('getHolidays', () => {
    it('filters holidays to the requested calendar year', async () => {
      await service.getHolidays(2026);

      expect(prisma.holiday.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            date: {
              gte: new Date(Date.UTC(2026, 0, 1)),
              lte: new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)),
            },
          },
          orderBy: { date: 'asc' },
        }),
      );
    });
  });
});
