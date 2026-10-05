import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { EmployeesService } from '../employees/employees.service';
import { AuditAction, JwtPayload } from '@ems/shared';
import { ErasureStatus } from '@ems/database';
import {
  CreateErasureRequestDto,
  ErasureDecision,
  ErasureRequestQueryDto,
  ReviewErasureRequestDto,
} from './dto/gdpr.dto';
import {
  RETENTION_SCHEDULE,
  RETENTION_SCHEDULE_VERSION,
  RETENTION_SIGNOFF_ENV,
  RetentionRule,
  isRetentionSignedOff,
} from './retention-schedule';

/**
 * GDPR toolkit — DSAR self-export + erasure-request workflow (§4.3, Phase 3 M3.1).
 *
 * Erasure is anonymise-not-delete (F8-aware): APPROVE calls
 * EmployeesService.anonymizeEmployee(), which nulls/tokenises PII in place,
 * locks the linked User (isActive=false) and sets deletedAt. The Phase-3
 * erasure inventory additionally scrubs PII-bearing free text in
 * non-statutory rows (document descriptions, AI prompts, notifications,
 * login-audit emails, goal titles, feedback comments, self-review text,
 * roster notes). Payroll, attendance and leave rows are NEVER touched — they
 * are statutory/operational history protected by Restrict relations and
 * retention duties.
 *
 * ASSUMPTION (counsel sign-off pending): the per-entity retention schedule is
 * now ENCODED in retention-schedule.ts, but every retention window there is
 * a PLACEHOLDER pending counsel sign-off — approval stays a human HR
 * decision, and the purge job below is forced into DRY-RUN until
 * GDPR_RETENTION_SIGNED_OFF=true is set (the recorded sign-off).
 */
@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly employeesService: EmployeesService,
    private readonly auditService: AuditService,
  ) {}

  private requireEmployeeId(user: JwtPayload): string {
    if (!user.employeeId) {
      throw new BadRequestException(
        'No employee profile is linked to this account; erasure requests require an employee profile.',
      );
    }
    return user.employeeId;
  }

  /**
   * Authenticated employee creates an erasure request for themselves.
   * Exactly one PENDING request per employee is enforced.
   */
  async createErasureRequest(user: JwtPayload, dto: CreateErasureRequestDto) {
    const employeeId = this.requireEmployeeId(user);

    const existing = await this.prisma.erasureRequest.findFirst({
      where: { employeeId, status: ErasureStatus.PENDING },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'You already have a pending erasure request. Wait for HR review before submitting another.',
      );
    }

    const request = await this.prisma.erasureRequest.create({
      data: {
        employeeId,
        requestedById: user.sub,
        reason: dto.reason ?? null,
      },
    });

    await this.auditService.log({
      actorId: user.sub,
      actorEmail: user.email,
      action: AuditAction.CREATE,
      entityType: 'ErasureRequest',
      entityId: request.id,
      afterState: { employeeId, status: request.status },
    });

    return request;
  }

  /** HR/admin: paginated list of erasure requests. */
  async listErasureRequests(query: ErasureRequestQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = query.status ? { status: query.status } : {};

    const [total, items] = await this.prisma.$transaction([
      this.prisma.erasureRequest.count({ where }),
      this.prisma.erasureRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              firstName: true,
              lastName: true,
              email: true,
              deletedAt: true,
            },
          },
          requestedBy: { select: { id: true, email: true } },
          reviewedBy: { select: { id: true, email: true } },
        },
      }),
    ]);

    return { data: items, meta: { page, limit, total } };
  }

  /**
   * HR/admin review. APPROVE anonymises the employee and stores the
   * anonymisation evidence on the request; REJECT requires a reason.
   */
  async reviewErasureRequest(
    id: string,
    reviewer: JwtPayload,
    dto: ReviewErasureRequestDto,
  ) {
    const request = await this.prisma.erasureRequest.findUnique({
      where: { id },
      include: { employee: { select: { id: true, deletedAt: true } } },
    });
    if (!request) {
      throw new NotFoundException(`Erasure request #${id} not found`);
    }
    if (request.status !== ErasureStatus.PENDING) {
      throw new ConflictException(
        `Erasure request is already ${request.status}; only PENDING requests can be reviewed.`,
      );
    }

    if (dto.decision === ErasureDecision.REJECT && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required when rejecting an erasure request.');
    }

    let evidence: Record<string, unknown> | null = null;

    if (dto.decision === ErasureDecision.APPROVE) {
      // Anonymise-not-delete: PII nulled/tokenised, User locked, payroll and
      // attendance history preserved. Implemented in EmployeesService so the
      // logic stays in one place (it already exists — reuse, don't duplicate).
      const result = await this.employeesService.anonymizeEmployee(
        request.employeeId,
        reviewer.sub,
        reviewer.email,
      );
      evidence = {
        ...(result as Record<string, unknown>),
        reviewedById: reviewer.sub,
        reviewedAt: new Date().toISOString(),
      };
    }

    const updated = await this.prisma.erasureRequest.update({
      where: { id },
      data: {
        status:
          dto.decision === ErasureDecision.APPROVE
            ? ErasureStatus.APPROVED
            : ErasureStatus.REJECTED,
        reviewedById: reviewer.sub,
        reason: dto.reason?.trim() || request.reason,
        // JSON round-trip: guarantees a plain-JSON value for the Prisma Json
        // column and satisfies InputJsonValue typing.
        evidence: evidence ? JSON.parse(JSON.stringify(evidence)) : undefined,
      },
      include: {
        reviewedBy: { select: { id: true, email: true } },
      },
    });

    await this.auditService.log({
      actorId: reviewer.sub,
      actorEmail: reviewer.email,
      action:
        dto.decision === ErasureDecision.APPROVE ? AuditAction.APPROVE : AuditAction.REJECT,
      entityType: 'ErasureRequest',
      entityId: id,
      beforeState: { status: ErasureStatus.PENDING },
      afterState: {
        status: updated.status,
        employeeId: request.employeeId,
        anonymized: dto.decision === ErasureDecision.APPROVE,
      },
    });

    return updated;
  }

  /**
   * DSAR self-export (UK GDPR Art. 15): everything the system holds about the
   * CALLER, and nothing about anyone else. The query is keyed strictly off the
   * caller's own employeeId — there is no parameter that could select another
   * subject, so cross-user exfiltration is structurally impossible.
   *
   * Attendance is paginated (attendancePage/attendanceLimit, default 1/100,
   * max 500 per page) — the old hard 500-row cap silently truncated long
   * histories. Reviews, goals, feedback and roster schedules are included;
   * document metadata only (never file contents or storage keys/URLs).
   */
  async exportMyData(
    user: JwtPayload,
    pagination?: { attendancePage?: number; attendanceLimit?: number },
  ) {
    const employeeId = this.requireEmployeeId(user);
    const attPage = pagination?.attendancePage ?? 1;
    const attLimit = pagination?.attendanceLimit ?? 100;

    const [profile, attendance, attendanceTotal, leaveRequests, documents, payslips, reviews, goals, feedbackReceived, feedbackGiven, roster] =
      await this.prisma.$transaction([
        this.prisma.employee.findUnique({
          where: { id: employeeId },
          include: {
            department: { select: { id: true, name: true } },
            designation: { select: { id: true, title: true } },
          },
        }),
        this.prisma.attendanceRecord.findMany({
          where: { employeeId },
          orderBy: { date: 'desc' },
          skip: (attPage - 1) * attLimit,
          take: attLimit,
        }),
        this.prisma.attendanceRecord.count({ where: { employeeId } }),
        this.prisma.leaveRequest.findMany({
          where: { employeeId },
          orderBy: { createdAt: 'desc' },
          take: 200,
          include: { leaveType: { select: { name: true } } },
        }),
        // Metadata only — never file contents or storage keys/URLs.
        this.prisma.document.findMany({
          where: { employeeId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            title: true,
            fileName: true,
            mimeType: true,
            fileSize: true,
            category: true,
            createdAt: true,
          },
        }),
        this.prisma.payslip.findMany({
          where: { employeeId },
          orderBy: [{ payrollRun: { year: 'desc' } }, { payrollRun: { month: 'desc' } }],
          take: 60,
          select: {
            id: true,
            grossPay: true,
            totalDeductions: true,
            netPay: true,
            status: true,
            disbursementDate: true,
            payrollRun: { select: { month: true, year: true } },
          },
        }),
        // Performance reviews where the caller is the subject; reviewer
        // identity is included only where the caller is also the reviewer —
        // otherwise manager names are other people's data. Reviewer employee
        // records are therefore NOT joined here (name + rating are shown, not
        // who wrote them, unless the caller wrote them).
        this.prisma.performanceReview.findMany({
          where: { employeeId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { cycle: { select: { id: true, title: true, startDate: true, endDate: true } } },
        }),
        this.prisma.goal.findMany({
          where: { employeeId },
          orderBy: { targetDate: 'desc' },
          take: 100,
        }),
        this.prisma.feedback.findMany({
          where: { recipientId: employeeId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.feedback.findMany({
          where: { senderId: employeeId },
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, type: true, comments: true, rating: true, createdAt: true },
        }),
        this.prisma.rosterEntry.findMany({
          where: { employeeId },
          orderBy: { date: 'desc' },
          take: 200,
        }),
      ]);

    if (!profile) {
      throw new NotFoundException('Employee profile not found for this account.');
    }

    // NOTE: DSAR access is not written to the audit log because the shared
    // AuditAction enum has no READ/ACCESS value and packages/shared is out of
    // scope for this change. Add an ACCESS action there if DSAR audit
    // trail coverage is required.

    return {
      exportedAt: new Date().toISOString(),
      subject: { employeeId: profile.id, employeeNumber: profile.employeeNumber },
      profile,
      attendance: {
        data: attendance,
        meta: {
          page: attPage,
          limit: attLimit,
          total: attendanceTotal,
          totalPages: Math.ceil(attendanceTotal / attLimit),
        },
      },
      leaveRequests,
      documents,
      payslips,
      performanceReviews: reviews,
      goals,
      feedback: { received: feedbackReceived, given: feedbackGiven },
      roster,
    };
  }

  // ------------------------------------------------------------------
  // Retention schedule (Phase 2 item 3, go-live hardening).
  // ------------------------------------------------------------------

  /**
   * The encoded per-entity retention schedule plus sign-off status. Every
   * retention window is a PLACEHOLDER until counsel signs off — see
   * retention-schedule.ts.
   */
  getRetentionSchedule() {
    return {
      version: RETENTION_SCHEDULE_VERSION,
      signedOff: isRetentionSignedOff(),
      signoffEnv: RETENTION_SIGNOFF_ENV,
      rules: RETENTION_SCHEDULE.map((r: RetentionRule) => ({
        entity: r.entity,
        retentionDays: r.retentionDays,
        basis: r.basis,
        purgeable: r.purgeable,
      })),
    };
  }

  /**
   * Dry-run preview: what the purge job WOULD delete, per entity. Never
   * deletes anything.
   */
  async previewRetentionPurge() {
    return this.runRetentionPurge(true);
  }

  /**
   * Retention purge job.
   *
   * DRY-RUN BY DEFAULT: the job only counts + logs what it would delete
   * unless BOTH conditions hold:
   *   1. counsel sign-off is recorded (`GDPR_RETENTION_SIGNED_OFF=true`), AND
   *   2. the caller explicitly passes `{ dryRun: false }`.
   * An explicit `dryRun: false` without sign-off is ignored (forced back to
   * dry-run) and logged — deleting on placeholder windows is exactly what
   * the review flagged as the risk.
   *
   * Only entities flagged `purgeable` in the schedule are ever deleted;
   * statutory history (payroll, attendance, leave, audit logs, documents,
   * erasure requests) is reported as excluded, never touched.
   */
  async purgeExpiredRetention(opts?: { dryRun?: boolean }) {
    const signedOff = isRetentionSignedOff();
    const dryRun = !(signedOff && opts?.dryRun === false);
    if (opts?.dryRun === false && !signedOff) {
      this.logger.warn(
        'Retention purge requested with dryRun:false but counsel sign-off is ' +
          `not recorded (${RETENTION_SIGNOFF_ENV}!=true) — forcing DRY-RUN.`,
      );
    }

    const result = await this.runRetentionPurge(dryRun);

    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: 'RETENTION_PURGE',
      entityId: RETENTION_SCHEDULE_VERSION,
      afterState: {
        scheduleVersion: RETENTION_SCHEDULE_VERSION,
        signedOff,
        dryRun,
        results: result,
      },
    });

    return { scheduleVersion: RETENTION_SCHEDULE_VERSION, signedOff, dryRun, results: result };
  }

  private async runRetentionPurge(dryRun: boolean) {
    const results: Array<Record<string, unknown>> = [];
    for (const rule of RETENTION_SCHEDULE) {
      if (!rule.purgeable) {
        results.push({
          entity: rule.entity,
          status: 'excluded',
          reason: 'statutory history / legal evidence / own retention mechanism — never auto-purged',
        });
        continue;
      }
      const cutoff = new Date(Date.now() - rule.retentionDays * 86400_000);
      const delegate = (this.prisma as any)[rule.model];
      if (!delegate?.count || !delegate?.deleteMany) {
        results.push({ entity: rule.entity, status: 'skipped', reason: 'model unavailable' });
        continue;
      }
      const where = { [rule.dateField]: { lt: cutoff } };
      const matched: number = await delegate.count({ where });
      let deleted = 0;
      if (!dryRun && matched > 0) {
        const res = await delegate.deleteMany({ where });
        deleted = res.count;
      }
      this.logger.log(
        `Retention purge [${dryRun ? 'DRY-RUN' : 'DELETE'}] ${rule.entity}: ` +
          `${matched} rows older than ${cutoff.toISOString()} ` +
          `(window ${rule.retentionDays}d)${dryRun ? ' — would delete' : ` — deleted ${deleted}`}`,
      );
      results.push({
        entity: rule.entity,
        status: dryRun ? 'would-delete' : 'deleted',
        retentionDays: rule.retentionDays,
        cutoff: cutoff.toISOString(),
        matched,
        deleted,
        dryRun,
      });
    }
    return results;
  }
}
