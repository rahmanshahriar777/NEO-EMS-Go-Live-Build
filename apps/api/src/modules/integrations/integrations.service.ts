import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { toCsv } from '../reports/export/csv';
import { LeaveStatus } from '@prisma/client';
import { SendAlertDto, HrisEmployeeImportItemDto, QuickBooksAccountMappingDto } from './dto/integrations.dto';

/**
 * Integrations (Phase 3 item 5).
 *
 * 1. Leave calendar iCal feed — GET /integrations/ical/:token (public,
 *    token-authenticated). The token is a self-contained HMAC so no schema
 *    change is needed: `v1.<userId>.<hmac>`, where
 *    hmac = HMAC_SHA256("ical-feed:<userId>", ICAL_FEED_SECRET).
 *    Rotation = change ICAL_FEED_SECRET (invalidates all feeds at once).
 * 2. Slack/Teams webhook alerts — config-driven; honest no-op when
 *    unconfigured (never claims delivery).
 * 3. Accounting CSV export — double-entry journal lines per payslip.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // ------------------------------------------------------------ iCal feed

  private icalSecret(): string {
    const secret = this.configService.get<string>('ICAL_FEED_SECRET') || '';
    if (!secret) {
      // Fail closed: issuing or verifying feed tokens without a secret would
      // make every feed trivially forgeable.
      throw new BadRequestException(
        'ICAL_FEED_SECRET is not configured; the leave calendar feed is disabled',
      );
    }
    return secret;
  }

  /** Builds a feed token for a user (used by account/profile endpoints). */
  buildFeedToken(userId: string): string {
    const mac = createHmac('sha256', this.icalSecret())
      .update(`ical-feed:${userId}`, 'utf8')
      .digest('hex');
    return `v1.${userId}.${mac}`;
  }

  /** Verifies a feed token and returns the userId, or throws 401. */
  verifyFeedToken(token: string): string {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
      throw new UnauthorizedException('Invalid calendar feed token');
    }
    const [, userId, mac] = parts;
    const expected = createHmac('sha256', this.icalSecret())
      .update(`ical-feed:${userId}`, 'utf8')
      .digest('hex');
    const a = Buffer.from(mac, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid calendar feed token');
    }
    return userId;
  }

  private icalDate(d: Date): string {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  private icalEscape(text: string): string {
    return String(text ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * Builds the VCALENDAR for a user: their APPROVED leave requests (past 90
   * days + upcoming) plus company holidays. Scope: the token holder's own
   * leave only — never anyone else's.
   */
  async buildLeaveCalendar(token: string): Promise<string> {
    const userId = this.verifyFeedToken(token);

    const employee = await this.prisma.employee.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!employee) {
      throw new UnauthorizedException('No employee profile linked to this feed');
    }

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 90);

    const [requests, holidays] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId: employee.id,
          status: LeaveStatus.APPROVED,
          endDate: { gte: since },
        },
        include: { leaveType: { select: { name: true } } },
        orderBy: { startDate: 'asc' },
      }),
      this.prisma.holiday.findMany({
        where: { date: { gte: since } },
        orderBy: { date: 'asc' },
      }),
    ]);

    const name = `${employee.firstName} ${employee.lastName}`.trim();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const events: string[] = [];

    for (const r of requests as any[]) {
      // DTEND is exclusive in iCal: add one day to the inclusive endDate.
      const endExclusive = new Date(r.endDate);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      events.push(
        [
          'BEGIN:VEVENT',
          `UID:leave-${r.id}@neo-ems`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${this.icalDate(new Date(r.startDate))}`,
          `DTEND;VALUE=DATE:${this.icalDate(endExclusive)}`,
          `SUMMARY:${this.icalEscape(`Leave — ${name} (${r.leaveType?.name ?? 'Leave'})`)}`,
          `DESCRIPTION:${this.icalEscape(`Approved leave request (${Number(r.totalDays)} days)`)}`,
          'TRANSP:OPAQUE',
          'END:VEVENT',
        ].join('\r\n'),
      );
    }

    for (const h of holidays as any[]) {
      const day = new Date(h.date);
      const next = new Date(day);
      next.setUTCDate(next.getUTCDate() + 1);
      events.push(
        [
          'BEGIN:VEVENT',
          `UID:holiday-${h.id}@neo-ems`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${this.icalDate(day)}`,
          `DTEND;VALUE=DATE:${this.icalDate(next)}`,
          `SUMMARY:${this.icalEscape(`Holiday — ${h.title}`)}`,
          'TRANSP:TRANSPARENT',
          'END:VEVENT',
        ].join('\r\n'),
      );
    }

    return (
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//NEO EMS//Leave Calendar//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${this.icalEscape(`Leave calendar — ${name}`)}`,
        ...events,
        'END:VCALENDAR',
      ].join('\r\n') + '\r\n'
    );
  }

  // ------------------------------------------------------- webhook alerts

  private webhookTimeoutMs(): number {
    return parseInt(this.configService.get<string>('WEBHOOK_TIMEOUT_MS') || '10000', 10);
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.webhookTimeoutMs());
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`webhook responded ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends an alert to configured Slack/Teams incoming webhooks. Config-driven:
   * each channel with no URL is reported as `not_configured` (never as sent).
   * Webhook URLs are never logged.
   */
  async sendAlert(input: { title: string; message: string; linkUrl?: string }): Promise<{
    slack: 'sent' | 'not_configured' | 'failed';
    teams: 'sent' | 'not_configured' | 'failed';
  }> {
    const text = input.linkUrl ? `${input.message}\n${input.linkUrl}` : input.message;

    const send = async (
      url: string | undefined,
      body: unknown,
      channel: string,
    ): Promise<'sent' | 'not_configured' | 'failed'> => {
      if (!url) {
        this.logger.debug(`${channel} webhook not configured; skipping alert`);
        return 'not_configured';
      }
      try {
        await this.postJson(url, body);
        return 'sent';
      } catch (e: any) {
        this.logger.warn(`${channel} webhook alert failed: ${e.message}`);
        return 'failed';
      }
    };

    const [slack, teams] = await Promise.all([
      send(
        this.configService.get<string>('SLACK_WEBHOOK_URL') || undefined,
        { text: `*${input.title}*\n${text}` },
        'Slack',
      ),
      send(
        this.configService.get<string>('TEAMS_WEBHOOK_URL') || undefined,
        {
          '@type': 'MessageCard',
          '@context': 'http://schema.org/extensions',
          themeColor: '0078D4',
          summary: input.title,
          sections: [{ activityTitle: input.title, text: input.linkUrl ? `${input.message}\n\n${input.linkUrl}` : input.message }],
        },
        'Teams',
      ),
    ]);

    return { slack, teams };
  }

  // ------------------------------------------------------- accounting export

  /**
   * Accounting CSV export for a payroll run (Phase 3 item 5).
   *
   * Double-entry journal per payslip (assumption — confirm account codes with
   * finance; overridable via ACCOUNTING_*_ACCOUNT env):
   *   DR wages expense (gross) / CR deductions payable / CR net pay payable.
   */
  async accountingExport(payrollRunId: string): Promise<{ csv: string; filename: string }> {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      include: {
        payslips: {
          include: {
            employee: { select: { employeeNumber: true, firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!run) throw new BadRequestException('Payroll run not found');

    const wagesAccount = this.configService.get<string>('ACCOUNTING_WAGES_EXPENSE_ACCOUNT') || '6000';
    const deductionsAccount = this.configService.get<string>('ACCOUNTING_DEDUCTIONS_PAYABLE_ACCOUNT') || '2100';
    const netPayAccount = this.configService.get<string>('ACCOUNTING_NET_PAY_PAYABLE_ACCOUNT') || '2200';
    const currency = this.configService.get<string>('PAYROLL_CURRENCY') || 'GBP';

    const period = `${run.year}-${String(run.month).padStart(2, '0')}`;
    const slips = (run.payslips as any[]) ?? [];
    const valueDate =
      slips[0]?.disbursementDate
        ? new Date(slips[0].disbursementDate).toISOString().slice(0, 10)
        : `${period}-01`;

    const headers = [
      'date', 'journal_ref', 'account_code', 'account_name',
      'debit', 'credit', 'currency', 'employee_number', 'description',
    ];
    const rows: unknown[][] = [];
    slips.forEach((slip, i) => {
      const ref = `PAY/${period}/${String(i + 1).padStart(4, '0')}`;
      const empNo = slip.employee?.employeeNumber ?? '';
      const desc = `Payroll ${period} — ${slip.employee?.firstName ?? ''} ${slip.employee?.lastName ?? ''}`.trim();
      const gross = Number(slip.grossPay).toFixed(2);
      const ded = Number(slip.totalDeductions).toFixed(2);
      const net = Number(slip.netPay).toFixed(2);
      rows.push(
        [valueDate, ref, wagesAccount, 'Wages & Salaries', gross, '', currency, empNo, desc],
        [valueDate, ref, deductionsAccount, 'Payroll Deductions Payable', '', ded, currency, empNo, desc],
        [valueDate, ref, netPayAccount, 'Net Pay Payable', '', net, currency, empNo, desc],
      );
    });

    return { csv: toCsv(headers, rows), filename: `accounting-journal-${period}.csv` };
  }

  /** Dispatches an alert to Slack and Teams webhooks. */
  async dispatchAlert(input: SendAlertDto) {
    return this.sendAlert(input);
  }

  /**
   * Bulk synchronises employee records from an external HRIS provider.
   */
  async importHrisEmployees(
    records: HrisEmployeeImportItemDto[],
  ): Promise<{ imported: number; updated: number; failed: number; errors: string[] }> {
    let imported = 0;
    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of records) {
      if (!row.email || !row.firstName || !row.lastName) {
        failed++;
        errors.push(`Row missing mandatory fields: ${JSON.stringify(row)}`);
        continue;
      }

      try {
        const existing = await this.prisma.employee.findUnique({
          where: { email: row.email.toLowerCase().trim() },
        });

        if (existing) {
          await this.prisma.employee.update({
            where: { id: existing.id },
            data: {
              firstName: row.firstName.trim(),
              lastName: row.lastName.trim(),
              phone: row.phone || existing.phone,
            },
          });
          updated++;
        } else {
          await this.prisma.employee.create({
            data: {
              firstName: row.firstName.trim(),
              lastName: row.lastName.trim(),
              email: row.email.toLowerCase().trim(),
              phone: row.phone,
              employeeNumber: `EMP-${Date.now().toString().slice(-4)}-${Math.floor(Math.random() * 900 + 100)}`,
            },
          });
          imported++;
        }
      } catch (err: any) {
        failed++;
        errors.push(`Failed to import ${row.email}: ${err.message}`);
      }
    }

    return { imported, updated, failed, errors };
  }

  // -------------------------------------------------- QuickBooks Integration

  private qboConnection: {
    realmId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    companyName?: string;
  } | null = null;

  private qboBaseUrl(): string {
    const env = this.configService.get<string>('QUICKBOOKS_ENVIRONMENT') || 'sandbox';
    return env === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
  }

  private qboAuthHeader(): string {
    const clientId = this.configService.get<string>('QUICKBOOKS_CLIENT_ID') || '';
    const clientSecret = this.configService.get<string>('QUICKBOOKS_CLIENT_SECRET') || '';
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  /**
   * Generates Intuit QuickBooks OAuth 2.0 authorization URL
   */
  getQuickBooksAuthUrl(state = 'qbo-init'): { url: string } {
    const clientId = this.configService.get<string>('QUICKBOOKS_CLIENT_ID');
    const redirectUri =
      this.configService.get<string>('QUICKBOOKS_REDIRECT_URI') ||
      'http://localhost:3000/integrations?tab=quickbooks';
    const scope = this.configService.get<string>(
      'QUICKBOOKS_SCOPES',
      'com.intuit.quickbooks.accounting',
    );

    if (!clientId) {
      throw new BadRequestException('QUICKBOOKS_CLIENT_ID is not configured in environment');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      scope,
      redirect_uri: redirectUri,
      state,
    });

    return {
      url: `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`,
    };
  }

  /**
   * Exchanges OAuth authorization code for Access & Refresh tokens
   */
  async handleQuickBooksCallback(
    code: string,
    realmId: string,
  ): Promise<{
    status: string;
    realmId: string;
    companyName?: string;
  }> {
    const redirectUri =
      this.configService.get<string>('QUICKBOOKS_REDIRECT_URI') ||
      'http://localhost:3000/integrations?tab=quickbooks';

    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.qboAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      this.logger.error(`QuickBooks token exchange failed: ${err}`);
      throw new BadRequestException('Failed to exchange authorization code with Intuit QuickBooks');
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    this.qboConnection = {
      realmId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
    };

    // Query CompanyInfo to fetch legal business name
    try {
      const companyRes = await fetch(
        `${this.qboBaseUrl()}/v3/company/${realmId}/companyinfo/${realmId}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${tokens.access_token}`,
          },
        },
      );
      if (companyRes.ok) {
        const companyData = await companyRes.json();
        this.qboConnection.companyName =
          companyData.CompanyInfo?.CompanyName || 'QuickBooks Company';
      }
    } catch (e) {
      this.logger.warn(`Could not fetch QuickBooks company info: ${e.message}`);
    }

    this.logger.log(`QuickBooks connected successfully for company realmId: ${realmId}`);
    return {
      status: 'connected',
      realmId,
      companyName: this.qboConnection.companyName,
    };
  }

  /**
   * Returns current QuickBooks connection status
   */
  async getQuickBooksStatus(): Promise<{
    connected: boolean;
    realmId?: string;
    companyName?: string;
    expiresAt?: string;
  }> {
    const staticToken = this.configService.get<string>('QUICKBOOKS_ACCESS_TOKEN');
    const staticRealmId = this.configService.get<string>('QUICKBOOKS_REALM_ID');

    if (!this.qboConnection && staticToken && staticRealmId) {
      return {
        connected: true,
        realmId: staticRealmId,
        companyName: 'QuickBooks Connected (Static Config)',
      };
    }

    if (!this.qboConnection) {
      return { connected: false };
    }

    return {
      connected: true,
      realmId: this.qboConnection.realmId,
      companyName: this.qboConnection.companyName,
      expiresAt: this.qboConnection.expiresAt.toISOString(),
    };
  }

  /**
   * Disconnects QuickBooks integration
   */
  disconnectQuickBooks(): { success: boolean; message: string } {
    this.qboConnection = null;
    return { success: true, message: 'QuickBooks Online integration disconnected.' };
  }

  /**
   * Ensures active access token, refreshing if expired
   */
  private async ensureQuickBooksToken(): Promise<{ accessToken: string; realmId: string }> {
    const staticToken = this.configService.get<string>('QUICKBOOKS_ACCESS_TOKEN');
    const staticRealmId = this.configService.get<string>('QUICKBOOKS_REALM_ID');
    if (staticToken && staticRealmId) {
      return { accessToken: staticToken, realmId: staticRealmId };
    }

    if (!this.qboConnection) {
      throw new BadRequestException(
        'QuickBooks Online is not connected. Please connect via OAuth first.',
      );
    }

    // Refresh if expired or expiring within 60 seconds
    if (this.qboConnection.expiresAt.getTime() - Date.now() < 60000) {
      this.logger.log('QuickBooks access token expired or expiring soon; refreshing...');
      const refreshRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.qboAuthHeader(),
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.qboConnection.refreshToken,
        }).toString(),
      });

      if (!refreshRes.ok) {
        this.qboConnection = null;
        throw new BadRequestException('QuickBooks session expired. Please reconnect to QuickBooks.');
      }

      const refreshed = await refreshRes.json();
      this.qboConnection.accessToken = refreshed.access_token;
      this.qboConnection.refreshToken =
        refreshed.refresh_token || this.qboConnection.refreshToken;
      this.qboConnection.expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
    }

    return {
      accessToken: this.qboConnection.accessToken,
      realmId: this.qboConnection.realmId,
    };
  }

  /**
   * Fetches active chart of accounts from QuickBooks Online for mapping
   */
  async getQuickBooksAccounts(): Promise<any[]> {
    const { accessToken, realmId } = await this.ensureQuickBooksToken();
    const query = encodeURIComponent(
      'SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Active = true MAXRESULTS 200',
    );
    const res = await fetch(`${this.qboBaseUrl()}/v3/company/${realmId}/query?query=${query}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`QuickBooks query accounts failed: ${err}`);
      throw new BadRequestException('Failed to retrieve Chart of Accounts from QuickBooks Online');
    }

    const data = await res.json();
    return data.QueryResponse?.Account || [];
  }

  /**
   * Synchronizes a finalized payroll run to QuickBooks Online as an automated Journal Entry
   */
  async syncPayrollToQuickBooks(
    payrollRunId: string,
    mapping: QuickBooksAccountMappingDto,
  ): Promise<{
    success: boolean;
    journalEntryId: string;
    docNumber: string;
    totalAmount: number;
    period: string;
  }> {
    const { accessToken, realmId } = await this.ensureQuickBooksToken();

    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      include: {
        payslips: {
          select: { grossPay: true, totalDeductions: true, netPay: true },
        },
      },
    });

    if (!run) throw new BadRequestException('Payroll run not found');

    const totalGross = run.payslips.reduce((acc, p) => acc + Number(p.grossPay), 0);
    const totalDeductions = run.payslips.reduce((acc, p) => acc + Number(p.totalDeductions), 0);
    const totalNet = run.payslips.reduce((acc, p) => acc + Number(p.netPay), 0);

    const period = `${run.year}-${String(run.month).padStart(2, '0')}`;
    const txnDate = `${period}-01`;

    const journalEntry = {
      TxnDate: txnDate,
      DocNumber: `PAY/${period}`,
      PrivateNote: `NEO-EMS Automated Payroll Disbursement — Period ${period}`,
      Line: [
        {
          Description: `Gross Wages & Salaries Expense (${period})`,
          Amount: parseFloat(totalGross.toFixed(2)),
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: mapping.wagesExpenseAccountId },
          },
        },
        {
          Description: `Payroll Deductions & Taxes Payable (${period})`,
          Amount: parseFloat(totalDeductions.toFixed(2)),
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: mapping.deductionsPayableAccountId },
          },
        },
        {
          Description: `Net Pay Disbursement (${period})`,
          Amount: parseFloat(totalNet.toFixed(2)),
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: mapping.netPayBankAccountId },
          },
        },
      ],
    };

    const res = await fetch(`${this.qboBaseUrl()}/v3/company/${realmId}/journalentry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(journalEntry),
    });

    if (!res.ok) {
      const errorText = await res.text();
      this.logger.error(`QuickBooks JournalEntry creation failed: ${errorText}`);
      throw new BadRequestException(`QuickBooks Online rejected journal entry: ${errorText}`);
    }

    const created = await res.json();
    return {
      success: true,
      journalEntryId: created.JournalEntry.Id,
      docNumber: created.JournalEntry.DocNumber,
      totalAmount: created.JournalEntry.TotalAmt,
      period,
    };
  }

}
