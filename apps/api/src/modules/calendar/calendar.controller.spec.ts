/**
 * IntegrationsController + CalendarController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { IntegrationsController } from '../integrations/integrations.controller';
import { IntegrationsService } from '../integrations/integrations.service';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

describe('IntegrationsController', () => {
  let controller: IntegrationsController;
  let service: any;

  const res: any = () => ({ setHeader: jest.fn(), send: jest.fn() });

  beforeEach(async () => {
    service = { buildLeaveCalendar: jest.fn(), accountingExport: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IntegrationsController],
      providers: [{ provide: IntegrationsService, useValue: service }],
    }).compile();

    controller = module.get<IntegrationsController>(IntegrationsController);
  });

  it('getIcalFeed streams the calendar with download headers', async () => {
    service.buildLeaveCalendar.mockResolvedValue('BEGIN:VCALENDAR');
    const r = res();

    await controller.getIcalFeed('hmac-token', r);

    expect(service.buildLeaveCalendar).toHaveBeenCalledWith('hmac-token');
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'text/calendar; charset=utf-8');
    expect(r.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="leave-calendar.ics"',
    );
    expect(r.send).toHaveBeenCalledWith('BEGIN:VCALENDAR');
  });

  it('accountingExport streams the journal CSV', async () => {
    service.accountingExport.mockResolvedValue({ csv: 'a,b', filename: 'journal.csv' });
    const r = res();

    await controller.accountingExport('run-1', r);

    expect(service.accountingExport).toHaveBeenCalledWith('run-1');
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(r.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="journal.csv"',
    );
    expect(r.send).toHaveBeenCalledWith('a,b');
  });
});

describe('CalendarController', () => {
  let controller: CalendarController;
  let service: any;

  const user: any = { sub: 'user-1', email: 'u@ems.local' };

  beforeEach(async () => {
    service = { getEvents: jest.fn(), getHolidays: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CalendarController],
      providers: [{ provide: CalendarService, useValue: service }],
    }).compile();

    controller = module.get<CalendarController>(CalendarController);
  });

  it('getEvents uses the query range, defaulting to now + 30 days', () => {
    service.getEvents.mockReturnValue([]);
    const query: any = { from: '2026-10-01', to: '2026-10-31' };
    controller.getEvents(query, user);
    expect(service.getEvents).toHaveBeenCalledWith(
      new Date('2026-10-01'),
      new Date('2026-10-31'),
      user,
    );
  });

  it('getEvents defaults from=now when omitted', () => {
    service.getEvents.mockReturnValue([]);
    const before = Date.now();
    controller.getEvents({} as any, user);
    const [from, end] = service.getEvents.mock.calls[0];
    expect(from.getTime()).toBeGreaterThanOrEqual(before);
    expect(end.getTime() - from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('getHolidays defaults to the current year', () => {
    service.getHolidays.mockReturnValue([]);
    controller.getHolidays({} as any);
    expect(service.getHolidays).toHaveBeenCalledWith(new Date().getUTCFullYear());

    controller.getHolidays({ year: 2027 } as any);
    expect(service.getHolidays).toHaveBeenCalledWith(2027);
  });
});
