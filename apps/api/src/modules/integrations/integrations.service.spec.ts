import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntegrationsService } from './integrations.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UnauthorizedException } from '@nestjs/common';

describe('IntegrationsService', () => {
  let service: IntegrationsService;
  let prisma: any;

  const build = async (env: Record<string, string> = {}) => {
    prisma = {
      employee: { findFirst: jest.fn() },
      leaveRequest: { findMany: jest.fn().mockResolvedValue([]) },
      holiday: { findMany: jest.fn().mockResolvedValue([]) },
      payrollRun: { findUnique: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntegrationsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => env[k] ?? undefined) },
        },
      ],
    }).compile();
    service = module.get<IntegrationsService>(IntegrationsService);
  };

  describe('iCal feed tokens', () => {
    it('builds and verifies a token', async () => {
      await build({ ICAL_FEED_SECRET: 'test-secret' });
      const token = service.buildFeedToken('user-1');
      expect(token.startsWith('v1.user-1.')).toBe(true);
      expect(service.verifyFeedToken(token)).toBe('user-1');
    });

    it('rejects forged tokens', async () => {
      await build({ ICAL_FEED_SECRET: 'test-secret' });
      expect(() => service.verifyFeedToken('v1.user-1.deadbeef')).toThrow(UnauthorizedException);
      expect(() => service.verifyFeedToken('garbage')).toThrow(UnauthorizedException);
    });

    it('fails closed when ICAL_FEED_SECRET is unset', async () => {
      await build({});
      expect(() => service.buildFeedToken('user-1')).toThrow(/ICAL_FEED_SECRET/);
      expect(() => service.verifyFeedToken('v1.user-1.abc')).toThrow(/ICAL_FEED_SECRET/);
    });

    it('builds a valid VCALENDAR with approved leave and holidays', async () => {
      await build({ ICAL_FEED_SECRET: 'test-secret' });
      prisma.employee.findFirst.mockResolvedValue({
        id: 'emp-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      prisma.leaveRequest.findMany.mockResolvedValue([
        {
          id: 'lr-1',
          startDate: new Date('2026-10-10'),
          endDate: new Date('2026-10-12'),
          totalDays: 3,
          leaveType: { name: 'Annual' },
        },
      ]);
      prisma.holiday.findMany.mockResolvedValue([
        { id: 'h-1', title: 'Christmas Day', date: new Date('2026-12-25') },
      ]);

      const token = service.buildFeedToken('user-1');
      const ics = await service.buildLeaveCalendar(token);

      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('END:VCALENDAR');
      expect(ics).toContain('UID:leave-lr-1@neo-ems');
      expect(ics).toContain('DTSTART;VALUE=DATE:20261010');
      // DTEND is exclusive: 12th → 13th.
      expect(ics).toContain('DTEND;VALUE=DATE:20261013');
      expect(ics).toContain('UID:holiday-h-1@neo-ems');
      expect(ics).toContain('Ada Lovelace');
    });
  });

  describe('webhook alerts', () => {
    it('no-ops honestly when unconfigured', async () => {
      await build({});
      const result = await service.sendAlert({ title: 'T', message: 'M' });
      expect(result).toEqual({ slack: 'not_configured', teams: 'not_configured' });
    });

    it('posts to configured webhooks', async () => {
      await build({
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        TEAMS_WEBHOOK_URL: 'https://teams.test/y',
      });
      const calls: Array<{ url: string; body: any }> = [];
      (global as any).fetch = jest.fn(async (url: string, opts: any) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return { ok: true };
      });

      const result = await service.sendAlert({
        title: 'Payroll paid',
        message: 'Run done',
        linkUrl: 'https://x',
      });
      expect(result).toEqual({ slack: 'sent', teams: 'sent' });
      expect(calls).toHaveLength(2);
      expect(calls[0].body.text).toContain('Payroll paid');
      expect(calls[1].body['@type']).toBe('MessageCard');

      delete (global as any).fetch;
    });

    it('reports failed on webhook errors', async () => {
      await build({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500 }));

      const result = await service.sendAlert({ title: 'T', message: 'M' });
      expect(result.slack).toBe('failed');
      expect(result.teams).toBe('not_configured');

      delete (global as any).fetch;
    });
  });

  describe('accounting export', () => {
    it('emits balanced double-entry lines per payslip', async () => {
      await build({});
      prisma.payrollRun.findUnique.mockResolvedValue({
        id: 'run-1',
        month: 9,
        year: 2026,
        payslips: [
          {
            grossPay: 6000,
            totalDeductions: 1000,
            netPay: 5000,
            disbursementDate: new Date('2026-10-01'),
            employee: { employeeNumber: 'EMP-001', firstName: 'Ada', lastName: 'Lovelace' },
          },
        ],
      });

      const { csv, filename } = await service.accountingExport('run-1');
      expect(filename).toBe('accounting-journal-2026-09.csv');
      const lines = csv.trim().split('\r\n');
      expect(lines).toHaveLength(4); // header + 3 journal lines
      expect(lines[0]).toContain('account_code');
      expect(lines[0]).toContain('debit');
      expect(lines[0]).toContain('credit');
      // DR wages gross
      expect(lines[1]).toContain('6000,Wages');
      expect(lines[1]).toMatch(/6000\.00,,/);
      // CR deductions + CR net pay balance the debit
      expect(lines[2]).toMatch(/,1000\.00,/);
      expect(lines[3]).toMatch(/,5000\.00,/);
    });
  });
});
