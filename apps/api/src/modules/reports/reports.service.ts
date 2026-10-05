import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { QueueService } from '../../core/queues/queue.service';
import { getCorrelationId } from '../../common/correlation/correlation';
import { toCsv } from './export/csv';
import { toXlsx, XlsxCell } from './export/xlsx';
import { renderPdf } from './export/pdf';

/**
 * Reporting & exports (Phase 3 item 2).
 *
 * Report types: headcount | turnover | absence | overtime | payroll-cost.
 * Formats: csv | xlsx | pdf (dependency-free writers in ./export).
 *
 * Assumptions (documented per contract):
 * - Turnover: leavers = employees currently TERMINATED/RESIGNED; without a
 *   termination-date column the report is a point-in-time snapshot, not a
 *   true period rate. Schema worker: Employee.terminationDate.
 * - Overtime: hours beyond 8.0 in a day (standard full-time shift).
 * - Absence: AttendanceRecord rows with status ABSENT (ON_LEAVE counted
 *   separately, not as absence).
 * - Payroll cost: stored PayrollRun totals (single-compute rule — never
 *   recomputed here). Currency is the deployment currency (PAYROLL_CURRENCY,
 *   default GBP); per-run currency needs a PayrollRun.currency column
 *   (schema worker).
 *
 * Scheduled delivery: worker 4 owns the cron; it calls
 * ReportsService.runScheduledReports(). Schedules come from the
 * REPORT_SCHEDULES env var (JSON array) until a ReportSchedule table lands
 * (schema worker): [{ type, format, recipients: [email], subject? }].
 */
export type ReportType = 'headcount' | 'turnover' | 'absence' | 'overtime' | 'payroll-cost';
export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

export const REPORT_TYPES: ReportType[] = ['headcount', 'turnover', 'absence', 'overtime', 'payroll-cost'];
export const REPORT_FORMATS: ReportFormat[] = ['csv', 'xlsx', 'pdf'];

interface ReportSchedule {
  type: ReportType;
  format: ReportFormat;
  recipients: string[];
  subject?: string;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly queueService: QueueService,
  ) {
    this.currency = this.configService.get<string>('PAYROLL_CURRENCY') || 'GBP';
  }

  // ------------------------------------------------------------------ builders

  async buildReport(
    type: ReportType,
    opts: { from?: string; to?: string; departmentId?: string } = {},
  ): Promise<{ title: string; headers: string[]; rows: unknown[][] }> {
    switch (type) {
      case 'headcount':
        return this.headcountReport(opts);
      case 'turnover':
        return this.turnoverReport(opts);
      case 'absence':
        return this.absenceReport(opts);
      case 'overtime':
        return this.overtimeReport(opts);
      case 'payroll-cost':
        return this.payrollCostReport(opts);
      default:
        throw new BadRequestException(`Unknown report type: ${type}`);
    }
  }

  private async headcountReport(opts: { departmentId?: string }) {
    const where: any = {
      deletedAt: null,
      ...(opts.departmentId ? { departmentId: opts.departmentId } : {}),
    };
    const [total, byStatus, byDepartment] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.groupBy({ by: ['status'], where, _count: { status: true } }),
      this.prisma.employee.groupBy({ by: ['departmentId'], where, _count: { departmentId: true } }),
    ]);
    const deptNames = new Map<string, string>();
    const depts = await this.prisma.department.findMany({
      where: { id: { in: byDepartment.map((d) => d.departmentId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });
    for (const d of depts) deptNames.set(d.id, d.name);

    const rows: unknown[][] = [
      ['Total headcount', total],
      [],
      ['By employment status', 'Count'],
      ...byStatus.map((g) => [g.status, g._count.status]),
      [],
      ['By department', 'Count'],
      ...byDepartment.map((g) => [g.departmentId ? deptNames.get(g.departmentId) ?? g.departmentId : '(unassigned)', g._count.departmentId]),
    ];
    return { title: 'Headcount report', headers: ['Metric', 'Value'], rows };
  }

  private async turnoverReport(_opts: { from?: string; to?: string }) {
    // Point-in-time snapshot: without Employee.terminationDate we cannot
    // attribute leavers to a period. Documented limitation (see header).
    const [total, leavers] = await Promise.all([
      this.prisma.employee.count({ where: { deletedAt: null } }),
      this.prisma.employee.count({
        where: { deletedAt: null, status: { in: ['TERMINATED', 'RESIGNED'] as any } },
      }),
    ]);
    const active = total - leavers;
    const rate = total > 0 ? Number(((leavers / total) * 100).toFixed(1)) : 0;
    return {
      title: 'Turnover report (point-in-time snapshot)',
      headers: ['Metric', 'Value'],
      rows: [
        ['Total employees', total],
        ['Active', active],
        ['Leavers (terminated/resigned)', leavers],
        ['Turnover rate %', rate],
        [],
        ['Note', 'Period attribution needs Employee.terminationDate (schema worker)'],
      ],
    };
  }

  private async absenceReport(opts: { from?: string; to?: string; departmentId?: string }) {
    const { from, to } = this.dateRange(opts, 30);
    const where: any = {
      date: { gte: from, lte: to },
      status: 'ABSENT' as any,
      ...(opts.departmentId ? { employee: { departmentId: opts.departmentId } } : {}),
    };
    const records = await this.prisma.attendanceRecord.findMany({
      where,
      select: {
        employeeId: true,
        date: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
    });
    const byEmployee = new Map<string, { name: string; number: string; days: number }>();
    for (const r of records as any[]) {
      const key = r.employeeId;
      const entry = byEmployee.get(key) ?? {
        name: `${r.employee?.firstName ?? ''} ${r.employee?.lastName ?? ''}`.trim(),
        number: r.employee?.employeeNumber ?? '',
        days: 0,
      };
      entry.days += 1;
      byEmployee.set(key, entry);
    }
    const rows = [...byEmployee.values()]
      .map((e) => [e.number, e.name, e.days] as unknown[])
      .sort((a, b) => Number(b[2]) - Number(a[2]));
    return {
      title: `Absence report ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
      headers: ['Employee number', 'Employee', 'Absent days'],
      rows: [...rows, [], ['Total absence days', '', records.length]],
    };
  }

  private async overtimeReport(opts: { from?: string; to?: string; departmentId?: string }) {
    const { from, to } = this.dateRange(opts, 30);
    const where: any = {
      date: { gte: from, lte: to },
      totalHoursWorked: { not: null },
      ...(opts.departmentId ? { employee: { departmentId: opts.departmentId } } : {}),
    };
    const records = await this.prisma.attendanceRecord.findMany({
      where,
      select: {
        totalHoursWorked: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
    });
    const byEmployee = new Map<string, { name: string; number: string; hours: number }>();
    for (const r of records as any[]) {
      const hours = Number(r.totalHoursWorked ?? 0);
      const ot = Math.max(0, Number((hours - 8).toFixed(2)));
      if (ot <= 0) continue;
      const key = r.employee?.employeeNumber ?? r.employee?.firstName ?? 'unknown';
      const entry = byEmployee.get(key) ?? {
        name: `${r.employee?.firstName ?? ''} ${r.employee?.lastName ?? ''}`.trim(),
        number: r.employee?.employeeNumber ?? '',
        hours: 0,
      };
      entry.hours = Number((entry.hours + ot).toFixed(2));
      byEmployee.set(key, entry);
    }
    const rows = [...byEmployee.values()]
      .map((e) => [e.number, e.name, e.hours] as unknown[])
      .sort((a, b) => Number(b[2]) - Number(a[2]));
    const total = rows.reduce((s, r) => s + Number(r[2]), 0);
    return {
      title: `Overtime report ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
      headers: ['Employee number', 'Employee', 'Overtime hours (>8h/day)'],
      rows: [...rows, [], ['Total overtime hours', '', Number(total.toFixed(2))]],
    };
  }

  private async payrollCostReport(opts: { from?: string; to?: string; departmentId?: string }) {
    const runs = await this.prisma.payrollRun.findMany({
      where: {
        status: { not: 'CANCELLED' as any },
        ...(opts.from || opts.to
          ? {
              AND: [
                ...(opts.from
                  ? [{ OR: [{ year: { gt: Number(opts.from.slice(0, 4)) } }, { AND: [{ year: Number(opts.from.slice(0, 4)) }, { month: { gte: Number(opts.from.slice(5, 7)) } }] }] }]
                  : []),
                ...(opts.to
                  ? [{ OR: [{ year: { lt: Number(opts.to.slice(0, 4)) } }, { AND: [{ year: Number(opts.to.slice(0, 4)) }, { month: { lte: Number(opts.to.slice(5, 7)) } }] }] }]
                  : []),
              ],
            }
          : {}),
      },
      select: {
        month: true,
        year: true,
        status: true,
        totalGross: true,
        totalDeductions: true,
        totalNet: true,
        departmentId: true,
        department: { select: { name: true } },
        _count: { select: { payslips: true } },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 24,
    });
    // Department slice: only department-scoped runs for that department.
    // Company-wide runs are excluded rather than misattributed.
    const runsFiltered = (runs as any[]).filter(
      (r) => !opts.departmentId || r.departmentId === opts.departmentId,
    );
    const rows = runsFiltered.map((r) => [
      `${r.year}-${String(r.month).padStart(2, '0')}`,
      r.department?.name ?? '(company-wide)',
      r.status,
      r._count.payslips,
      Number(r.totalGross).toFixed(2),
      Number(r.totalDeductions).toFixed(2),
      Number(r.totalNet).toFixed(2),
      this.currency,
    ]);
    return {
      title: 'Payroll cost report',
      headers: ['Period', 'Scope', 'Status', 'Payslips', 'Gross', 'Deductions', 'Net', 'Currency'],
      rows,
    };
  }

  private dateRange(opts: { from?: string; to?: string }, defaultDays: number) {
    const to = opts.to ? new Date(opts.to) : new Date();
    const from = opts.from ? new Date(opts.from) : new Date(to.getTime() - defaultDays * 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('Invalid from/to date range (expected YYYY-MM-DD)');
    }
    return { from, to };
  }

  // ------------------------------------------------------------------ export

  async exportReport(
    type: ReportType,
    format: ReportFormat,
    opts: { from?: string; to?: string; departmentId?: string } = {},
  ): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
    const report = await this.buildReport(type, opts);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${type}-report-${stamp}`;

    if (format === 'csv') {
      return {
        buffer: Buffer.from(toCsv(report.headers, report.rows), 'utf8'),
        filename: `${base}.csv`,
        contentType: 'text/csv; charset=utf-8',
      };
    }
    if (format === 'xlsx') {
      return {
        buffer: toXlsx(report.headers, report.rows as XlsxCell[][]),
        filename: `${base}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    // pdf
    return {
      buffer: renderPdf({
        title: report.title,
        sections: [
          {
            table: {
              headers: report.headers,
              rows: report.rows.map((r) => r.map((c) => String(c ?? ''))),
            },
          },
        ],
        footer: 'NEO EMS — Reports',
      }),
      filename: `${base}.pdf`,
      contentType: 'application/pdf',
    };
  }

  // ------------------------------------------------------- scheduled delivery

  private readSchedules(): ReportSchedule[] {
    const raw = this.configService.get<string>('REPORT_SCHEDULES') || '[]';
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (s: any) =>
          s && REPORT_TYPES.includes(s.type) && REPORT_FORMATS.includes(s.format) && Array.isArray(s.recipients),
      );
    } catch (e: any) {
      this.logger.warn(`REPORT_SCHEDULES is not valid JSON; skipping scheduled reports: ${e.message}`);
      return [];
    }
  }

  /**
   * Runs all due scheduled reports and emails them. Called by worker 4's cron
   * (cadence lives there); this method processes every configured schedule
   * on each invocation. Schema worker: replace REPORT_SCHEDULES with a
   * ReportSchedule table (reportType, format, recipients, cronExpr,
   * lastRunAt, isActive).
   *
   * Delivery goes through the LIVE `notifications` queue (channel 'email')
   * as user-less email-only jobs: the worker's email hook resolves the
   * recipient from `data.email` and attaches the generated file. (The old
   * standalone `email` queue had no consumer — HIGH #2 — and is deleted.)
   */
  async runScheduledReports(): Promise<{ ran: number; emailed: number; errors: string[] }> {
    const schedules = this.readSchedules();
    let emailed = 0;
    const errors: string[] = [];

    for (const s of schedules) {
      try {
        const { buffer, filename } = await this.exportReport(s.type, s.format);
        const correlationId = getCorrelationId() ?? randomUUID();
        for (const to of s.recipients) {
          const jobId = await this.queueService.enqueueNotification(
            undefined, // no userId: email-only job to a raw address
            'email',
            'scheduled-report',
            {
              email: to,
              subject: s.subject ?? `Scheduled report: ${s.type}`,
              title: s.subject ?? `Scheduled report: ${s.type}`,
              message: `Attached: ${filename} (generated ${new Date().toISOString()}).`,
              attachment: { filename, contentBase64: buffer.toString('base64') },
            },
            correlationId,
            `scheduled-report:${s.type}:${s.format}:${to}:${new Date().toISOString().slice(0, 10)}`,
          );
          if (jobId) emailed++;
        }
      } catch (e: any) {
        const msg = `schedule ${s.type}/${s.format}: ${e.message}`;
        this.logger.warn(`runScheduledReports: ${msg}`);
        errors.push(msg);
      }
    }

    return { ran: schedules.length, emailed, errors };
  }
}
