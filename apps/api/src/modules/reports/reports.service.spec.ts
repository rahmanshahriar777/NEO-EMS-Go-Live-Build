import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QueueService } from '../../core/queues/queue.service';

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: any;
  let queueService: any;

  beforeEach(async () => {
    prisma = {
      employee: { count: jest.fn(), groupBy: jest.fn() },
      department: { findMany: jest.fn().mockResolvedValue([]) },
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      payrollRun: { findMany: jest.fn().mockResolvedValue([]) },
    };
    queueService = { enqueueNotification: jest.fn().mockResolvedValue('job-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  it('builds a headcount report', async () => {
    prisma.employee.count.mockResolvedValue(10);
    prisma.employee.groupBy
      .mockResolvedValueOnce([{ status: 'FULL_TIME', _count: { status: 8 } }])
      .mockResolvedValueOnce([{ departmentId: 'd1', _count: { departmentId: 8 } }]);
    prisma.department.findMany.mockResolvedValue([{ id: 'd1', name: 'Engineering' }]);

    const report = await service.buildReport('headcount', {});
    expect(report.headers).toEqual(['Metric', 'Value']);
    expect(report.rows[0]).toEqual(['Total headcount', 10]);
  });

  it('builds a turnover snapshot with documented limitation', async () => {
    prisma.employee.count.mockResolvedValueOnce(100).mockResolvedValueOnce(5);

    const report = await service.buildReport('turnover', {});
    expect(report.rows).toContainEqual(['Turnover rate %', 5]);
  });

  it('rejects unknown report types and invalid date ranges', async () => {
    await expect(service.buildReport('nope' as any, {})).rejects.toThrow();
    await expect(service.buildReport('absence', { from: '2026-10-10', to: '2026-10-01' })).rejects.toThrow();
  });

  it('exports CSV, XLSX and PDF', async () => {
    prisma.employee.count.mockResolvedValue(4);
    prisma.employee.groupBy.mockResolvedValue([]);
    prisma.department.findMany.mockResolvedValue([]);

    const csv = await service.exportReport('headcount', 'csv', {});
    expect(csv.filename).toMatch(/\.csv$/);
    expect(csv.buffer.toString('utf8')).toContain('Total headcount');

    const xlsx = await service.exportReport('headcount', 'xlsx', {});
    expect(xlsx.buffer.subarray(0, 4).toString('hex')).toBe('504b0304');

    const pdf = await service.exportReport('headcount', 'pdf', {});
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('runScheduledReports processes REPORT_SCHEDULES and emails recipients', async () => {
    prisma.employee.count.mockResolvedValue(4);
    prisma.employee.groupBy.mockResolvedValue([]);
    prisma.department.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'REPORT_SCHEDULES'
                ? JSON.stringify([{ type: 'headcount', format: 'csv', recipients: ['a@x.com', 'b@x.com'] }])
                : undefined,
            ),
          },
        },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();
    const svc = module.get<ReportsService>(ReportsService);

    const result = await svc.runScheduledReports();
    expect(result.ran).toBe(1);
    expect(result.emailed).toBe(2);
    expect(result.errors).toEqual([]);
    const call = queueService.enqueueNotification.mock.calls[0];
    // user-less email-only job on the live notifications queue (channel email)
    expect(call[0]).toBeUndefined();
    expect(call[1]).toBe('email');
    expect(call[2]).toBe('scheduled-report');
    expect(call[3].email).toBe('a@x.com');
    expect(call[3].attachment.filename).toMatch(/\.csv$/);
    expect(call[3].attachment.contentBase64).toBeTruthy();
    // stable idempotency key per recipient+day so retries never double-send
    expect(call[5]).toMatch(/^scheduled-report:headcount:csv:a@x\.com:/);
  });

  it('runScheduledReports tolerates invalid REPORT_SCHEDULES JSON', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('not-json') } },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();
    const svc = module.get<ReportsService>(ReportsService);

    await expect(svc.runScheduledReports()).resolves.toEqual({ ran: 0, emailed: 0, errors: [] });
  });
});
