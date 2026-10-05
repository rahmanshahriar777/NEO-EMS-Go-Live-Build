import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { QueueService } from '../../core/queues/queue.service';
import {
  CreateSalaryStructureDto,
  AssignSalaryDto,
  CreatePayrollRunDto,
  CreatePayslipCorrectionDto,
} from './dto/payroll.dto';
import {
  PayrollStatus,
  SalaryComponentType,
  AuditAction,
  createPaginatedResponse,
  toMinorUnits,
  fromMinorUnits,
} from '@ems/shared';
import { renderPayslipPdf } from './payroll-pdf';
import { toCsv } from '../reports/export/csv';

/**
 * Payroll correctness (F15) + Phase 2 item 4.
 *
 * SINGLE-COMPUTE RULE: this service NEVER computes payroll math. Gross /
 * deduction / net computation lives in exactly ONE place — the worker's
 * payroll processor (`apps/worker/src/processors/payroll-math.ts`, owned by
 * the payroll worker). The API creates DRAFT run shells, enqueues the compute
 * job (`payroll-run:<runId>`), and later reads the STORED results. This
 * removes the old dual implementation where the API and the worker each had
 * their own copy of the formula (and their own copy of the
 * PERCENTAGE_OF_GROSS bug).
 *
 * Computation contract the worker must honour (see handoff to payroll worker):
 *  - Eligibility: every non-deleted employee with an active salary structure
 *    whose employment status is payable (FULL_TIME, PART_TIME, CONTRACT,
 *    PROBATION, INTERN) — NOT only FULL_TIME as the old API filter did.
 *    TERMINATED / RESIGNED employees are excluded.
 *  - PERCENTAGE_OF_BASIC = value% of base salary; PERCENTAGE_OF_GROSS =
 *    value% of gross earnings (base salary + all EARNING components). The old
 *    shared helper computed both off base salary — that is the bug being
 *    fixed; the worker's canonical math is the single place it is fixed.
 *  - Proration: joiners/leavers in the pay month are prorated by calendar
 *    days in month (needs Employee.terminationDate — schema worker).
 *  - Unpaid leave: APPROVED leave on an unpaid leave type (LeaveType.isPaid =
 *    false) overlapping the pay month deducts pro-rata daily pay.
 *
 * Maker/checker: the approver must differ from the run creator. The creator
 * is resolved from the audit trail (RUN_PAYROLL action); when the creator is
 * unknown the approval fails closed with 403.
 * Approval no longer sets disbursementDate; a dedicated disburse endpoint
 * moves APPROVED -> PAID in a transaction and stamps disbursementDate on
 * each payslip (the run-level field is not in the schema contract).
 * Disbursement is idempotent: re-disbursing a PAID run is a no-op.
 * Duplicate company-wide runs (NULL departmentId) are guarded at the
 * service level via findFirst + P2002 mapping, in addition to the partial
 * unique index owned by the schema worker.
 * Currency defaults to PAYROLL_CURRENCY (default GBP).
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  private readonly defaultCurrency: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly configService: ConfigService,
    private readonly queues: QueueService,
  ) {
    // Assumption: operating currency comes from PAYROLL_CURRENCY, defaulting
    // to GBP for UK deployment readiness. Confirm with finance/accounting
    // before go-live (review §8 assumption 3). Schema worker: consider a
    // `currency` column on PayrollRun for multi-entity deployments (Phase 3
    // item 1); until then every run is assumed single-currency.
    this.defaultCurrency = this.configService.get<string>('PAYROLL_CURRENCY') || 'GBP';
  }

  // ---------------------------------------------------------------------------
  // Salary Structures
  // ---------------------------------------------------------------------------

  async getSalaryStructures(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.salaryStructure.findMany({
        skip,
        take: limit,
        include: {
          components: true,
          _count: { select: { employees: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.salaryStructure.count(),
    ]);
    return createPaginatedResponse(items, total, page, limit);
  }

  async createSalaryStructure(dto: CreateSalaryStructureDto, actorId?: string, actorEmail?: string) {
    const structure = await this.prisma.salaryStructure.create({
      data: {
        name: dto.name,
        description: dto.description,
        currency: dto.currency || this.defaultCurrency,
        components: {
          create: dto.components.map((c) => ({
            name: c.name,
            type: c.type as any,
            calculationType: c.calculationType as any,
            value: c.value,
            isTaxable: c.isTaxable ?? true,
          })),
        },
      },
      include: { components: true },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'SALARY_STRUCTURE',
      entityId: structure.id,
      afterState: structure,
    });

    return structure;
  }

  // ---------------------------------------------------------------------------
  // Employee Salary Assignment
  // ---------------------------------------------------------------------------

  async getEmployeeSalary(employeeId: string) {
    const assignment = await this.prisma.employeeSalaryStructure.findFirst({
      where: { employeeId, isActive: true },
      include: {
        salaryStructure: {
          include: { components: true },
        },
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (!assignment) {
      throw new NotFoundException(`No active salary structure found for employee #${employeeId}`);
    }

    return assignment;
  }

  async assignSalary(dto: AssignSalaryDto, actorId?: string, actorEmail?: string) {
    return this.prisma.$transaction(async (tx) => {
      // Deactivate previous active structures
      await tx.employeeSalaryStructure.updateMany({
        where: { employeeId: dto.employeeId, isActive: true },
        data: { isActive: false },
      });

      const newAssignment = await tx.employeeSalaryStructure.create({
        data: {
          employeeId: dto.employeeId,
          salaryStructureId: dto.salaryStructureId,
          baseSalary: dto.baseSalary,
          effectiveFrom: new Date(dto.effectiveFrom),
          isActive: true,
        },
        include: { salaryStructure: { include: { components: true } } },
      });

      await this.audit.log({
        actorId,
        actorEmail,
        action: AuditAction.UPDATE,
        entityType: 'EMPLOYEE_SALARY',
        entityId: dto.employeeId,
        afterState: newAssignment,
      });

      return newAssignment;
    });
  }

  // ---------------------------------------------------------------------------
  // Payroll Runs & Payslips
  // ---------------------------------------------------------------------------

  async getPayrollRuns(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.payrollRun.findMany({
        skip,
        take: limit,
        include: {
          department: { select: { id: true, name: true, code: true } },
          approvedBy: { select: { id: true, email: true } },
          _count: { select: { payslips: true } },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
      this.prisma.payrollRun.count(),
    ]);
    return createPaginatedResponse(items, total, page, limit);
  }

  async getPayrollRunById(id: string) {
    const run = await this.prisma.payrollRun.findUnique({
      where: { id },
      include: {
        department: { select: { id: true, name: true, code: true } },
        approvedBy: { select: { id: true, email: true } },
        payslips: {
          include: {
            employee: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true, email: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Payroll run #${id} not found`);
    }

    return run;
  }

  /**
   * Creates a DRAFT payroll run shell and enqueues computation.
   *
   * Single-compute rule: NO math happens here. The worker's payroll processor
   * computes every payslip (all employment types, proration, unpaid-leave
   * deductions) and upserts them; the run flips PROCESSING -> DRAFT when it
   * finishes. Clients poll GET /payroll/runs/:id until payslips appear.
   */
  async createPayrollRun(dto: CreatePayrollRunDto, actorId?: string, actorEmail?: string) {
    // Idempotency / duplicate guard (service-level): findFirst with an explicit
    // NULL departmentId matches company-wide runs despite Postgres NULL-distinct
    // unique semantics. The partial unique index (schema worker) is the DB backstop.
    const existing = await this.prisma.payrollRun.findFirst({
      where: {
        month: dto.month,
        year: dto.year,
        departmentId: dto.departmentId || null,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Payroll run for period ${dto.month}/${dto.year} already exists with status ${existing.status}`,
      );
    }

    let run: any;
    try {
      run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payrollRun.create({
          data: {
            month: dto.month,
            year: dto.year,
            departmentId: dto.departmentId,
            status: PayrollStatus.DRAFT,
            // Totals start at zero; the worker rolls them up after computing.
            totalGross: 0,
            totalDeductions: 0,
            totalNet: 0,
          },
          include: { payslips: true },
        });

        await this.audit.log({
          actorId,
          actorEmail,
          action: AuditAction.RUN_PAYROLL,
          entityType: 'PAYROLL_RUN',
          entityId: created.id,
          afterState: { id: created.id, month: created.month, year: created.year },
        });

        return created;
      });
    } catch (e: any) {
      // Belt-and-braces: map the unique-violation backstop to 409.
      if (e?.code === 'P2002') {
        throw new ConflictException(
          `Payroll run for period ${dto.month}/${dto.year} already exists`,
        );
      }
      throw e;
    }

    // Hand computation to the worker (retries/DLQ/idempotency key
    // `payroll-run:<runId>` handled by the queue contract). The worker owns
    // the ONLY copy of the payroll formula.
    await this.queues.enqueuePayrollRun(run.id, randomUUID());

    return run;
  }

  /**
   * Cancels a DRAFT run. Only DRAFT runs can be cancelled: PROCESSING means
   * the worker is mid-computation, and APPROVED/PAID runs are financial
   * history that must never be rewritten. Draft payslips are left in place
   * as an audit trail of what was computed; they carry no financial effect
   * until approval.
   */
  async cancelPayrollRun(id: string, actorId: string, actorEmail?: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Payroll run not found');

    if (run.status !== PayrollStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT payroll runs can be cancelled (current status: ${run.status})`,
      );
    }

    const cancelled = await this.prisma.payrollRun.update({
      where: { id },
      data: { status: PayrollStatus.CANCELLED },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'PAYROLL_RUN_CANCEL',
      entityId: id,
      afterState: { id, status: PayrollStatus.CANCELLED },
    });

    return cancelled;
  }

  /**
   * Recalculates a DRAFT run: drops the stored draft payslips (unapproved, so
   * no money has moved) and re-enqueues computation. The worker upserts fresh
   * payslips under the same idempotency key, so retries converge.
   * Not allowed while PROCESSING (the worker owns the rows then) or after
   * approval.
   */
  async recalculatePayrollRun(id: string, actorId: string, actorEmail?: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Payroll run not found');

    if (run.status !== PayrollStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT payroll runs can be recalculated (current status: ${run.status})`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payslip.deleteMany({ where: { payrollRunId: id } });
      await tx.payrollRun.update({
        where: { id },
        // v4 fix #8: warnings belong to a compute — recalculating clears them
        // so stale exclusions can't linger on a fresh run.
        data: { totalGross: 0, totalDeductions: 0, totalNet: 0, processedAt: null, warnings: [] },
      });
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'PAYROLL_RUN_RECALCULATE',
      entityId: id,
      afterState: { id, status: PayrollStatus.DRAFT },
    });

    await this.queues.enqueuePayrollRun(id, randomUUID());

    return this.getPayrollRunById(id);
  }

  /**
   * Maker/checker approval (F15). The approver must be a different user from
   * the run creator; the creator is resolved from the audit trail and an
   * unknown creator fails closed with 403.
   */
  async approvePayrollRun(id: string, actorId: string, actorEmail?: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Payroll run not found');

    if (run.status !== PayrollStatus.DRAFT) {
      throw new BadRequestException(
        `Only DRAFT payroll runs can be approved (current status: ${run.status})`,
      );
    }

    // Approve-before-compute race (v5): the worker computes payslips
    // asynchronously after run creation. Approving before compute finishes
    // would let the run disburse as PAID with zero payslips (and
    // recalculation is then blocked). Gate approval on compute completion:
    // the worker stamps processedAt when it commits the payslip rows.
    if (!run.processedAt) {
      throw new ConflictException(
        'Payroll run has not finished computing yet. Wait for the worker to process it before approving.',
      );
    }
    const payslipCount = await this.prisma.payslip.count({
      where: { payrollRunId: id },
    });
    if (payslipCount === 0) {
      throw new ConflictException(
        'Payroll run has no computed payslips. Approval requires at least one computed payslip.',
      );
    }

    // Maker/checker: resolve the creator from the audit trail.
    const creationAudit = await this.prisma.auditLog.findFirst({
      where: {
        entityType: 'PAYROLL_RUN',
        entityId: id,
        action: AuditAction.RUN_PAYROLL as any,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!creationAudit?.actorId) {
      // Fail-closed: without a known creator we cannot verify separation of duties.
      throw new ForbiddenException(
        'Payroll run creator is unknown; approval blocked (maker/checker fail-closed)',
      );
    }
    if (creationAudit.actorId === actorId) {
      throw new ForbiddenException(
        'Maker/checker violation: the approver must differ from the payroll run creator',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const approvedRun = await tx.payrollRun.update({
        where: { id },
        data: {
          status: PayrollStatus.APPROVED,
          approvedAt: new Date(),
          // approvedById is a real User FK (schema contract); the legacy
          // free-text approvedBy column is no longer written.
          approvedById: actorId,
        },
      });

      // Mark payslips APPROVED. disbursementDate is intentionally NOT set here;
      // only the disburse endpoint may stamp it (F15).
      await tx.payslip.updateMany({
        where: { payrollRunId: id },
        data: { status: PayrollStatus.APPROVED },
      });

      return approvedRun;
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.APPROVE,
      entityType: 'PAYROLL_RUN',
      entityId: id,
      afterState: updated,
    });

    return updated;
  }

  /**
   * Disburses an APPROVED run: APPROVED -> PAID in a transaction, stamping
   * disbursementDate on the run and every payslip. Idempotent: re-disbursing
   * a PAID run returns it unchanged (no-op). Any other status -> 409.
   *
   * Concurrency (F10): the APPROVED check above is not serialised with the
   * write below, so the transition itself is conditional — the update only
   * matches while the row is STILL APPROVED. The database serialises the
   * writers: exactly one wins, the loser gets P2025 and is re-classified as
   * a no-op (already PAID) or 409 (moved to any other state).
   */
  async disbursePayrollRun(id: string, actorId: string, actorEmail?: string) {
    const disbursementDate = new Date();
    const slipSelect = {
      payslips: {
        select: {
          id: true,
          employeeId: true,
          netPay: true,
          employee: { select: { userId: true } },
        },
      },
    };

    const { disbursed, updated } = await this.prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.findUnique({
        where: { id },
        include: slipSelect,
      });
      if (!run) throw new NotFoundException('Payroll run not found');

      // Idempotent no-op on re-disburse: stored state is returned unchanged.
      if (run.status === PayrollStatus.PAID) {
        this.logger.log(`Disburse no-op: payroll run ${id} is already PAID`);
        return { disbursed: false as const, updated: run };
      }

      if (run.status !== PayrollStatus.APPROVED) {
        throw new ConflictException(
          `Payroll run must be APPROVED before disbursement (current status: ${run.status})`,
        );
      }

      // Atomic guard: only the writer that still observes APPROVED moves the
      // run to PAID. (The `as any` is deliberate: Prisma's generated
      // WhereUniqueInput type only declares unique fields, but the query
      // engine applies the whole filter — `WHERE id AND status` — and throws
      // P2025 when no row matches. This is the standard Prisma optimistic-
      // locking pattern.)
      let paidRun: any;
      try {
        paidRun = await tx.payrollRun.update({
          where: { id, status: PayrollStatus.APPROVED } as any,
          data: { status: PayrollStatus.PAID },
        });
      } catch (e: any) {
        if (e?.code !== 'P2025') throw e;
        // Lost the race: re-read to distinguish "already PAID" (safe no-op)
        // from any other state (409), instead of trusting the stale read.
        const current = await tx.payrollRun.findUnique({
          where: { id },
          include: slipSelect,
        });
        if (!current) throw new NotFoundException('Payroll run not found');
        if (current.status !== PayrollStatus.PAID) {
          throw new ConflictException(
            `Payroll run must be APPROVED before disbursement (current status: ${current.status})`,
          );
        }
        this.logger.log(`Disburse lost race: payroll run ${id} is already PAID — no-op`);
        return { disbursed: false as const, updated: current };
      }

      await tx.payslip.updateMany({
        where: { payrollRunId: id },
        data: { status: PayrollStatus.PAID, disbursementDate },
      });

      return { disbursed: true as const, updated: { ...paidRun, payslips: run.payslips } };
    });

    // True idempotent no-op: no side effects — no audit write, no
    // notifications — and the stored disbursementDate is returned as-is
    // (never a fresh timestamp for money that already moved).
    if (!disbursed) {
      const { payslips: _noOpSlips, ...runWithoutSlips } = updated as any;
      return runWithoutSlips;
    }

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.APPROVE,
      entityType: 'PAYROLL_RUN_DISBURSE',
      entityId: id,
      afterState: { id, status: PayrollStatus.PAID, disbursementDate },
    });

    // Notify each employee that their payslip is ready. One job per payslip
    // with a stable idempotency key so retries never double-notify.
    const correlationId = randomUUID();
    for (const slip of (updated as any).payslips ?? []) {
      const userId = slip.employee?.userId;
      if (!userId) continue;
      await this.queues.enqueueNotification(
        userId,
        'in-app',
        'payslip-ready',
        {
          payrollRunId: id,
          payslipId: slip.id,
          netPay: slip.netPay?.toString?.() ?? String(slip.netPay),
          disbursementDate: disbursementDate.toISOString(),
        },
        correlationId,
        `payslip-ready:${slip.id}`,
      );
    }

    const { payslips: _slips, ...runWithoutSlips } = updated as any;
    return { ...runWithoutSlips, disbursementDate: disbursementDate.toISOString() };
  }

  async getPayslips(
    employeeId?: string,
    payrollRunId?: string,
    page = 1,
    limit = 20,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {
      ...(employeeId && { employeeId }),
      ...(payrollRunId && { payrollRunId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.payslip.findMany({
        where,
        skip,
        take: limit,
        include: {
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              employeeNumber: true,
              email: true,
              department: { select: { name: true } },
              designation: { select: { title: true } },
            },
          },
          payrollRun: {
            select: { id: true, month: true, year: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payslip.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }

  async getPayslipById(id: string) {
    const payslip = await this.prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeNumber: true,
            email: true,
            department: { select: { id: true, name: true } },
            designation: { select: { id: true, title: true } },
          },
        },
        payrollRun: {
          select: { id: true, month: true, year: true, status: true },
        },
      },
    });

    if (!payslip) {
      throw new NotFoundException(`Payslip #${id} not found`);
    }

    return payslip;
  }

  /**
   * Renders a payslip PDF from STORED data (Phase 2 item 4). No math happens
   * here — amounts are displayed exactly as the worker computed and stored.
   */
  async getPayslipPdf(id: string): Promise<{ buffer: Buffer; filename: string }> {
    const payslip = await this.getPayslipById(id);
    const run = payslip.payrollRun as any;
    const employee = payslip.employee as any;

    const periodLabel = run
      ? `${String(run.month).padStart(2, '0')}/${run.year}`
      : 'unknown period';

    const breakdown = Array.isArray(payslip.breakdown)
      ? (payslip.breakdown as Array<{ component: string; type: string; amount: number | string }>)
      : [];

    const buffer = renderPayslipPdf({
      employeeName: `${employee?.firstName ?? ''} ${employee?.lastName ?? ''}`.trim() || 'Unknown',
      employeeNumber: employee?.employeeNumber ?? '—',
      department: employee?.department?.name,
      designation: employee?.designation?.title,
      periodLabel,
      disbursementDate: payslip.disbursementDate
        ? new Date(payslip.disbursementDate).toISOString().slice(0, 10)
        : null,
      status: String(payslip.status),
      currency: this.defaultCurrency,
      grossPay: String(payslip.grossPay),
      totalDeductions: String(payslip.totalDeductions),
      netPay: String(payslip.netPay),
      breakdown,
    });

    const safeName = (employee?.employeeNumber ?? id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return { buffer, filename: `payslip-${safeName}-${periodLabel.replace('/', '-')}.pdf` };
  }

  /**
   * Manual payslip correction (Phase 2 item 4).
   *
   * Appends an HR-entered adjustment line to a DRAFT payslip's breakdown and
   * re-derives gross/deductions/net from the STORED breakdown using the
   * shared minor-unit helpers. This is an explicit human override, not
   * formula computation — the canonical formula stays solely in
   * @ems/shared payroll compute (single-compute rule).
   *
   * Only DRAFT payslips in DRAFT runs: APPROVED/PAID figures are financial
   * history — correct those via recalculation (DRAFT) or a next-period
   * adjustment, never by rewriting.
   */
  async addPayslipCorrection(
    payslipId: string,
    dto: CreatePayslipCorrectionDto,
    actorId: string,
    actorEmail?: string,
  ) {
    const payslip = await this.prisma.payslip.findUnique({
      where: { id: payslipId },
      include: { payrollRun: { select: { id: true, status: true, month: true, year: true } } },
    });
    if (!payslip) throw new NotFoundException(`Payslip #${payslipId} not found`);

    if (payslip.status !== PayrollStatus.DRAFT || payslip.payrollRun.status !== PayrollStatus.DRAFT) {
      throw new ConflictException(
        'Corrections are only allowed on DRAFT payslips in DRAFT runs. ' +
          'Approved/paid figures must be corrected via run recalculation or a next-period adjustment.',
      );
    }

    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Correction amount must be a positive number');
    }

    const currency = this.defaultCurrency;
    const adjustmentMinor = toMinorUnits(dto.amount, currency);
    let grossMinor = toMinorUnits(Number(payslip.grossPay), currency);
    let deductionsMinor = toMinorUnits(Number(payslip.totalDeductions), currency);

    if (dto.type === SalaryComponentType.EARNING) {
      grossMinor += adjustmentMinor;
    } else {
      deductionsMinor += adjustmentMinor;
    }
    const netMinor = Math.max(0, grossMinor - deductionsMinor);

    const breakdown = Array.isArray(payslip.breakdown) ? [...(payslip.breakdown as any[])] : [];
    breakdown.push({
      component: dto.label,
      type: dto.type,
      amount: fromMinorUnits(adjustmentMinor, currency),
      correction: true,
      reason: dto.reason,
      correctedBy: actorId,
      correctedAt: new Date().toISOString(),
    });

    const updated = await this.prisma.payslip.update({
      where: { id: payslipId },
      data: {
        grossPay: fromMinorUnits(grossMinor, currency),
        totalDeductions: fromMinorUnits(deductionsMinor, currency),
        netPay: fromMinorUnits(netMinor, currency),
        breakdown: breakdown as any,
      },
    });

    // Roll the run totals up (stored aggregates stay consistent).
    const run = await this.prisma.payrollRun.findUnique({
      where: { id: payslip.payrollRun.id },
      include: { payslips: { select: { grossPay: true, totalDeductions: true, netPay: true } } },
    });
    if (run) {
      const sum = (xs: any[], k: string) =>
        xs.reduce((s, p) => s + toMinorUnits(Number(p[k]), currency), 0);
      await this.prisma.payrollRun.update({
        where: { id: run.id },
        data: {
          totalGross: fromMinorUnits(sum(run.payslips, 'grossPay'), currency),
          totalDeductions: fromMinorUnits(sum(run.payslips, 'totalDeductions'), currency),
          totalNet: fromMinorUnits(sum(run.payslips, 'netPay'), currency),
        },
      });
    }

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'PAYSLIP_CORRECTION',
      entityId: payslipId,
      afterState: {
        payslipId,
        type: dto.type,
        label: dto.label,
        amount: dto.amount,
        reason: dto.reason,
        netPay: fromMinorUnits(netMinor, currency),
      },
    });

    return updated;
  }

  /**
   * Bank payment file (CSV) for a payroll run (Phase 2 item 4).
   *
   * Assumption: this export carries the payment instruction core (payee
   * reference, amount, currency, value date). Real destination account
   * numbers / sort codes come from Phase 2 item 3 (employee extended profile
   * with ENCRYPTED bank identifiers — worker 2); until that lands, the
   * `account_reference` column carries the employee number as the payee key
   * and finance maps it in the banking portal. Never put unencrypted account
   * numbers in this file.
   */
  async getBankPaymentCsv(runId: string): Promise<{ csv: string; filename: string }> {
    const run = await this.getPayrollRunById(runId);

    const headers = [
      'employee_number',
      'employee_name',
      'account_reference',
      'amount',
      'currency',
      'value_date',
      'payment_reference',
      'pay_period',
    ];

    const period = `${run.year}-${String(run.month).padStart(2, '0')}`;
    const valueDate = run.status === PayrollStatus.PAID && (run as any).payslips?.[0]?.disbursementDate
      ? new Date((run as any).payslips[0].disbursementDate).toISOString().slice(0, 10)
      : '';

    const rows = ((run as any).payslips ?? []).map((slip: any, i: number) => [
      slip.employee?.employeeNumber ?? '',
      `${slip.employee?.firstName ?? ''} ${slip.employee?.lastName ?? ''}`.trim(),
      slip.employee?.employeeNumber ?? '',
      Number(slip.netPay).toFixed(2),
      this.defaultCurrency,
      valueDate,
      `SAL/${period}/${String(i + 1).padStart(4, '0')}`,
      period,
    ]);

    return {
      csv: toCsv(headers, rows),
      filename: `bank-payments-${period}.csv`,
    };
  }
}
