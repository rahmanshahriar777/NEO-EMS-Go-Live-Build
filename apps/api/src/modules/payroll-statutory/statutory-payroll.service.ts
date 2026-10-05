import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { PayrollStatus, AuditAction } from '@ems/shared';
import {
  StatutoryPayrollProvider,
  StatutoryPayrollSubmissionRequest,
  StatutorySubmissionReceipt,
  StatutorySubmissionStatus,
} from './statutory-payroll-provider.interface';
import { SandboxStatutoryPayrollProvider } from './sandbox.provider';

/**
 * Statutory payroll orchestration (Phase 3 item 3).
 *
 * Provider selection: STATUTORY_PAYROLL_PROVIDER (default 'sandbox').
 * Unknown names fail closed at startup. Provider config is validated on
 * first use; misconfiguration throws loudly rather than silently filing
 * nowhere.
 *
 * Submission records: there is no StatutorySubmission table yet (schema
 * worker), so submissions are recorded as AuditLog rows
 * (entityType 'STATUTORY_SUBMISSION', entityId = submissionId) — durable,
 * tamper-evident, and queryable. Migrate to a dedicated table when it lands.
 *
 * Only APPROVED or PAID runs may be submitted — never DRAFT (unapproved
 * figures must not reach a statutory filing).
 */
@Injectable()
export class StatutoryPayrollService {
  private readonly logger = new Logger(StatutoryPayrollService.name);
  private readonly providerName: string;
  private readonly currency: string;
  private provider: StatutoryPayrollProvider | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly configService: ConfigService,
  ) {
    this.providerName = this.configService.get<string>('STATUTORY_PAYROLL_PROVIDER') || 'sandbox';
    this.currency = this.configService.get<string>('PAYROLL_CURRENCY') || 'GBP';
  }

  /** Resolve + validate the configured provider (fail-closed on unknown). */
  getProvider(): StatutoryPayrollProvider {
    if (this.provider) return this.provider;
    // Registry: add real providers here as they are implemented.
    const registry: Record<string, () => StatutoryPayrollProvider> = {
      sandbox: () => new SandboxStatutoryPayrollProvider(),
    };
    const factory = registry[this.providerName];
    if (!factory) {
      throw new BadRequestException(
        `Unknown statutory payroll provider '${this.providerName}'. ` +
          `Set STATUTORY_PAYROLL_PROVIDER to one of: ${Object.keys(registry).join(', ')}`,
      );
    }
    const provider = factory();
    provider.validateConfig();
    if (!provider.isSandbox) {
      this.logger.log(`Statutory payroll provider active: ${provider.name} (LIVE)`);
    } else {
      this.logger.warn(
        `Statutory payroll provider active: ${provider.name} (SANDBOX — not a real filing)`,
      );
    }
    this.provider = provider;
    return provider;
  }

  async submitRun(payrollRunId: string, actorId: string, actorEmail?: string): Promise<StatutorySubmissionReceipt> {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payrollRunId },
      include: {
        payslips: {
          include: {
            employee: { select: { id: true, employeeNumber: true } },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    if (run.status !== PayrollStatus.APPROVED && run.status !== PayrollStatus.PAID) {
      throw new BadRequestException(
        `Only APPROVED or PAID runs can be submitted to the statutory provider (current: ${run.status})`,
      );
    }

    const request: StatutoryPayrollSubmissionRequest = {
      payrollRunId,
      period: { month: run.month, year: run.year },
      submittedByUserId: actorId,
      currency: this.currency,
      employees: (run.payslips as any[]).map((p) => ({
        employeeId: p.employeeId,
        employeeNumber: p.employee?.employeeNumber ?? p.employeeId,
        grossPay: Number(p.grossPay),
        totalDeductions: Number(p.totalDeductions),
        netPay: Number(p.netPay),
        // Payroll identifiers (NI number, tax code) come from the employee
        // extended profile (Phase 2 item 3, worker 2). Until that lands the
        // provider receives figures only.
      })),
      totals: {
        grossPay: Number(run.totalGross),
        totalDeductions: Number(run.totalDeductions),
        netPay: Number(run.totalNet),
      },
    };

    const receipt = await this.getProvider().submitPayroll(request);

    // Durable record until the StatutorySubmission table lands (schema worker).
    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'STATUTORY_SUBMISSION',
      entityId: receipt.submissionId,
      afterState: {
        submissionId: receipt.submissionId,
        provider: receipt.provider,
        sandbox: receipt.sandbox,
        status: receipt.status,
        reference: receipt.reference,
        payrollRunId,
        period: request.period,
        employeeCount: request.employees.length,
        totals: request.totals,
        submittedAt: receipt.submittedAt,
      },
    });

    return receipt;
  }

  async getSubmissionStatus(submissionId: string): Promise<StatutorySubmissionStatus> {
    return this.getProvider().getSubmissionStatus(submissionId);
  }

  /** Past submissions, read back from the audit trail (until the table lands). */
  async listSubmissions(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { entityType: 'STATUTORY_SUBMISSION' };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { id: true, entityId: true, afterState: true, createdAt: true, actor: { select: { email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: items.map((i: any) => ({ ...(i.afterState as object), auditId: i.id, createdAt: i.createdAt })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
    };
  }
}
