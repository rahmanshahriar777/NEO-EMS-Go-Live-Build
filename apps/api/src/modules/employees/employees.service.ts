import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { pickKnownColumns } from '../../core/prisma/schema-compat.util';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
  EmployeeQueryDto,
  MANAGER_EDITABLE_FIELDS,
  EMPLOYEE_SORT_FIELDS,
} from './dto/employee.dto';
import { sanitizeEmployee } from './sanitize.util';
import { AuditAction, createPaginatedResponse, SystemRole, JwtPayload } from '@ems/shared';
import { nextEmployeeNumber } from '@ems/shared';
import { AvatarStorageService } from '../../core/storage/avatar-storage.service';

export interface EmployeeViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

export function toEmployeeViewer(user: JwtPayload): EmployeeViewer {
  return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
}

function isHrOrAdmin(roles: string[]): boolean {
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

/**
 * Normalizes the Phase-2 extended profile fields from the DTO into the
 * persisted shape.
 *
 * - The web UI sends flat `emergencyContactName/Phone/Relation` fields;
 *   they are merged into the `emergencyContact` JSON object
 *   { name, phone, relationship } (explicit object wins on conflicts).
 * - `contractEndDate` (UI field name) is an alias for `contractEnd`.
 *
 * Every key needs its column from worker 4's migration; persistence goes
 * through pickKnownColumns so unmigrated columns are skipped (logged), not
 * fatal. Required columns: Employee.emergencyContact (Json?),
 * Employee.contractStart/contractEnd (DateTime?), Employee.workLocation
 * (String?), Employee.bankAccountEnc/taxIdEnc (String?), Employee.timezone
 * (String?).
 */
function buildExtendedProfileData(dto: CreateEmployeeDto | UpdateEmployeeDto): Record<string, any> {
  const data: Record<string, any> = {};

  const flatContact: Record<string, any> = {};
  if (dto.emergencyContactName !== undefined) flatContact.name = dto.emergencyContactName;
  if (dto.emergencyContactPhone !== undefined) flatContact.phone = dto.emergencyContactPhone;
  if (dto.emergencyContactRelation !== undefined)
    flatContact.relationship = dto.emergencyContactRelation;
  const hasFlat = Object.keys(flatContact).length > 0;

  if (dto.emergencyContact !== undefined || hasFlat) {
    data.emergencyContact = {
      ...(hasFlat ? flatContact : {}),
      ...(dto.emergencyContact ?? {}),
    };
  }

  if (dto.contractStart) data.contractStart = new Date(dto.contractStart);
  const contractEnd = (dto as any).contractEndDate ?? dto.contractEnd;
  if (contractEnd) data.contractEnd = new Date(contractEnd);
  if (dto.workLocation !== undefined) data.workLocation = dto.workLocation;
  if (dto.bankAccountEnc !== undefined) data.bankAccountEnc = dto.bankAccountEnc;
  if (dto.taxIdEnc !== undefined) data.taxIdEnc = dto.taxIdEnc;
  if (dto.timezone !== undefined) data.timezone = dto.timezone;

  return data;
}

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly avatars: AvatarStorageService,
  ) {}

  /**
   * Resolve a stored avatar value to a client-usable URL. Object-storage
   * keys (`avatars/...`) become presigned GET URLs; legacy `data:` URLs and
   * external URLs pass through unchanged (go-live Phase 3 item 8).
   */
  private async resolveAvatarUrl(value: string | null | undefined): Promise<string | null> {
    if (!value) return null;
    if (value.startsWith('avatars/')) {
      return this.avatars.getAvatarUrl(value);
    }
    return value;
  }

  /**
   * Scoped list (F13): HR/SUPER_ADMIN see everyone; MANAGER sees themselves
   * plus direct reports; everyone else sees only themselves. Compensation is
   * stripped for viewers without HR/admin roles.
   */
  async findAllScoped(query: EmployeeQueryDto, viewer: EmployeeViewer) {
    const scopedQuery: EmployeeQueryDto = { ...query };

    if (!isHrOrAdmin(viewer.roles)) {
      if (!viewer.employeeId) {
        throw new ForbiddenException('User is not associated with an employee profile');
      }
      if (viewer.roles.includes(SystemRole.MANAGER)) {
        // Self + direct reports. Implemented as an OR merged in findAll via
        // the managerId filter extension below.
        (scopedQuery as any).scopeOr = [
          { id: viewer.employeeId },
          { managerId: viewer.employeeId },
        ];
      } else {
        (scopedQuery as any).scopeOr = [{ id: viewer.employeeId }];
      }
    }

    const result = await this.findAll(scopedQuery);
    const rawItems: any[] = Array.isArray((result as any).data?.items)
      ? (result as any).data.items
      : Array.isArray((result as any).data)
      ? (result as any).data
      : [];
    const items = await Promise.all(
      rawItems.map(async (e: any) => {
        const sanitized = sanitizeEmployee(e, viewer.roles);
        if (sanitized && typeof sanitized === 'object' && 'avatarUrl' in sanitized) {
          sanitized.avatarUrl = await this.resolveAvatarUrl((sanitized as any).avatarUrl);
        }
        return sanitized;
      }),
    );
    if ((result as any).data?.items) {
      return { ...result, data: { ...(result as any).data, items } };
    }
    return { ...(result as any), data: items };
  }

  async findAll(query: EmployeeQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      departmentId,
      designationId,
      managerId,
      status,
      entityId,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const skip = (page - 1) * limit;

    // Phase 1 refactoring: sortBy allowlist — unknown fields fall back to
    // createdAt instead of reaching the ORM.
    const orderField = (EMPLOYEE_SORT_FIELDS as readonly string[]).includes(sortBy)
      ? sortBy
      : 'createdAt';

    const where: any = {
      deletedAt: null,
      ...(departmentId && { departmentId }),
      ...(designationId && { designationId }),
      ...(managerId && { managerId }),
      ...(status && { status }),
      // Phase 3 multi-entity: only applied when the filter is provided, so
      // pre-migration databases (no Employee.entityId column) are unaffected.
      // Schema need (worker 4): Employee.entityId String?
      ...(entityId && { entityId }),
    };

    // Ownership scoping injected by findAllScoped (F13).
    const scopeOr = (query as any).scopeOr as any[] | undefined;
    if (scopeOr && scopeOr.length > 0) {
      where.AND = [{ OR: scopeOr }];
    }

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { employeeNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderField]: sortOrder },
        include: {
          department: { select: { id: true, name: true, code: true } },
          designation: { select: { id: true, title: true, code: true, level: true } },
          manager: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
          user: { select: { id: true, isActive: true } },
        },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id, deletedAt: null },
      include: {
        department: true,
        designation: true,
        manager: {
          select: { id: true, firstName: true, lastName: true, email: true, employeeNumber: true },
        },
        subordinates: {
          where: { deletedAt: null },
          select: { id: true, firstName: true, lastName: true, employeeNumber: true, designation: true },
        },
        user: {
          select: {
            id: true,
            email: true,
            isActive: true,
            roles: { include: { role: true } },
          },
        },
        leaveBalances: {
          where: { year: new Date().getFullYear() },
          include: { leaveType: true },
        },
        salaryStructures: {
          where: { isActive: true },
          include: { salaryStructure: { include: { components: true } } },
        },
        documents: true,
        history: {
          orderBy: { changedAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!employee) {
      throw new NotFoundException(`Employee #${id} not found`);
    }

    return this.resolveAvatarUrl((employee as any).avatarUrl).then((avatarUrl) => ({
      ...employee,
      avatarUrl,
    }));
  }

  /**
   * Scoped get (F13): HR/SUPER_ADMIN may read anyone; MANAGER may read
   * themselves and their direct reports; everyone else may read only
   * themselves. Compensation is stripped for non-HR/admin viewers.
   */
  async findOneScoped(id: string, viewer: EmployeeViewer) {
    if (!isHrOrAdmin(viewer.roles)) {
      if (!viewer.employeeId) {
        throw new ForbiddenException('User is not associated with an employee profile');
      }
      if (id !== viewer.employeeId) {
        const target = await this.prisma.employee.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, managerId: true },
        });
        const isDirectReport =
          viewer.roles.includes(SystemRole.MANAGER) && target?.managerId === viewer.employeeId;
        if (!isDirectReport) {
          throw new ForbiddenException('You do not have access to this employee profile');
        }
      }
    }

    const employee = await this.findOne(id);
    const scoped = sanitizeEmployee(employee, viewer.roles);
    if (scoped && typeof scoped === 'object' && 'avatarUrl' in (scoped as any)) {
      (scoped as any).avatarUrl = await this.resolveAvatarUrl((scoped as any).avatarUrl);
    }
    return scoped;
  }

  /**
   * GDPR erasure: anonymises PII in place (F8/F26-aware).
   *
   * - Nulls/tokenises direct identifiers (name, email, phone, DOB, address,
   *   avatar, profile summary) and locks the linked User account.
   * - NEVER touches payroll rows (payslips, salary assignments), attendance,
   *   leave, performance or document records — those are statutory/operational
   *   history protected by Restrict relations and retention duties.
   * - Returns an evidence payload for the ErasureRequest record.
   */
  async anonymizeEmployee(id: string, actorId?: string, actorEmail?: string) {
    const existing = await this.prisma.employee.findFirst({
      where: { id },
      include: {
        user: { select: { id: true, email: true } },
        _count: {
          select: {
            payslips: true,
            salaryStructures: true,
            attendance: true,
            leaveRequests: true,
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException(`Employee #${id} not found`);
    }

    const token = id.replace(/-/g, '').slice(0, 8);
    const redactedEmail = `redacted-${token}@deleted.local`;

    if (existing.email === redactedEmail || existing.email.endsWith('@deleted.local')) {
      return {
        employeeId: id,
        alreadyAnonymized: true,
        anonymizedAt: existing.deletedAt,
      };
    }

    const anonymizedFields = [
      'firstName',
      'lastName',
      'email',
      'phone',
      'dateOfBirth',
      'gender',
      'address',
      'profileSummary',
      'avatarUrl',
      // Phase 2 item 3 extended profile: sensitive/identifying fields are
      // cleared on erasure too.
      'emergencyContact',
      'workLocation',
      'bankAccountEnc',
      'taxIdEnc',
    ];

    const preservedRecords = {
      payslips: existing._count.payslips,
      salaryAssignments: existing._count.salaryStructures,
      attendanceRecords: existing._count.attendance,
      leaveRequests: existing._count.leaveRequests,
    };

    const anonymizedAt = new Date();

    let erasureInventory: Record<string, { scrubbed: number; retained: number; note: string }> = {};

    await this.prisma.$transaction(async (tx) => {
      // Extended-profile PII clearing (Phase 2 item 3); columns via worker 4
      // migration — skipped while unmigrated, not fatal.
      const extendedClear = await pickKnownColumns(
        this.prisma,
        'employees',
        {
          emergencyContact: null,
          workLocation: null,
          bankAccountEnc: null,
          taxIdEnc: null,
        },
        'EmployeesService.anonymizeEmployee',
      );

      await tx.employee.update({
        where: { id },
        data: {
          firstName: 'Redacted',
          lastName: `Employee-${token}`,
          email: redactedEmail,
          phone: null,
          dateOfBirth: null,
          gender: null,
          address: null,
          profileSummary: null,
          avatarUrl: null,
          status: 'TERMINATED',
          deletedAt: anonymizedAt,
          ...extendedClear,
        } as any,
      });

      if (existing.user) {
        await tx.user.update({
          where: { id: existing.user.id },
          data: {
            email: redactedEmail,
            isActive: false,
          },
        });
      }

      // Phase 3 erasure inventory: scrub PII-bearing free text in
      // non-statutory rows; statutory rows (payroll, leave, attendance) are
      // never touched. Counts feed the erasure evidence.
      erasureInventory = await this.scrubErasureInventory(
        tx,
        id,
        existing.user?.id,
        existing.email,
        token,
      );
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'EMPLOYEE_ERASURE',
      entityId: id,
      beforeState: { email: existing.email },
      afterState: {
        email: redactedEmail,
        anonymizedFields,
        preservedRecords,
        erasureInventory,
        anonymizedAt: anonymizedAt.toISOString(),
      },
    });

    this.logger.log(`Employee ${id} anonymised (GDPR erasure); statutory rows preserved`);

    return {
      employeeId: id,
      alreadyAnonymized: false,
      anonymizedAt: anonymizedAt.toISOString(),
      anonymizedFields,
      preservedRecords,
      erasureInventory,
      note: 'Payroll, attendance and leave rows were preserved untouched per statutory retention duties; PII-bearing free text in non-statutory rows was scrubbed (see erasureInventory).',
    };
  }

  /**
   * Phase 3 erasure inventory (GDPR Art. 17). Runs inside the erasure
   * transaction. Scrubs PII-bearing free text in NON-statutory rows; rows the
   * business has a legal obligation or legitimate interest to retain
   * (payroll, leave, attendance — and performance ratings as tribunal
   * evidence) keep their structured data. Every table reports
   * {scrubbed, retained} counts into the erasure evidence.
   *
   * ASSUMPTION (counsel sign-off pending): the retain-vs-scrub line below
   * follows UK GDPR Art. 17(3)(b) (legal obligation) and Art. 17(3)(e)
   * (legal claims). A signed retention schedule may move individual tables.
   */
  private async scrubErasureInventory(
    tx: any,
    employeeId: string,
    userId: string | undefined,
    userEmail: string,
    token: string,
  ): Promise<Record<string, { scrubbed: number; retained: number; note: string }>> {
    const REDACTED_TEXT = '[REDACTED — GDPR erasure]';
    const inventory: Record<string, { scrubbed: number; retained: number; note: string }> = {};
    const redactedEmail = `redacted-${token}@deleted.local`;

    // 1. Document metadata — free-text descriptions scrubbed; the document
    //    rows themselves (contracts etc.) are retained under Art. 17(3)(b).
    const docs = await tx.document.updateMany({
      where: { employeeId, deletedAt: null },
      data: { description: null },
    });
    inventory.documents = {
      scrubbed: docs.count,
      retained: docs.count,
      note: 'Free-text descriptions cleared; document rows retained (contracts/RTW evidence may be a legal obligation).',
    };

    // 2. AI request logs — prompts/responses are PII-bearing free text with
    //    no statutory retention; scrub content, keep the log rows for audit.
    if (userId) {
      const aiLogs = await tx.aIRequestLog.updateMany({
        where: { userId },
        data: { prompt: REDACTED_TEXT, response: null },
      });
      inventory.aiRequestLogs = {
        scrubbed: aiLogs.count,
        retained: aiLogs.count,
        note: 'Prompt/response content scrubbed; log rows retained for model-use auditability.',
      };

      // 3. Notifications — user-facing copy may name the subject; scrub.
      const notifs = await tx.notification.updateMany({
        where: { recipientId: userId },
        data: { title: REDACTED_TEXT, message: REDACTED_TEXT },
      });
      inventory.notifications = {
        scrubbed: notifs.count,
        retained: 0,
        note: 'Title/message scrubbed; rows retained as delivery records only.',
      };
    }

    // 4. Login-audit emails — the attempted address identifies the subject.
    //    IP/userAgent are kept: security logs are a legitimate interest
    //    (and often a legal obligation) under Art. 17(3).
    const loginAudits = await tx.loginAuditLog.updateMany({
      where: { OR: [{ userId: userId ?? '___never___' }, { emailAttempted: userEmail }] },
      data: { emailAttempted: redactedEmail },
    });
    inventory.loginAuditLogs = {
      scrubbed: loginAudits.count,
      retained: loginAudits.count,
      note: 'emailAttempted tokenised; IP/userAgent retained as security logs (legitimate interest).',
    };

    // 5. Goals — operational, not statutory; scrub free text, keep rows.
    const goals = await tx.goal.updateMany({
      where: { employeeId },
      data: { title: REDACTED_TEXT, description: null },
    });
    inventory.goals = {
      scrubbed: goals.count,
      retained: goals.count,
      note: 'Goal titles/descriptions scrubbed; progress/status retained as operational history.',
    };

    // 6. Feedback — comments scrubbed whether the subject gave or received
    //    them; structured ratings retained as anonymised aggregates.
    const feedback = await tx.feedback.updateMany({
      where: { OR: [{ senderId: employeeId }, { recipientId: employeeId }] },
      data: { comments: REDACTED_TEXT },
    });
    inventory.feedback = {
      scrubbed: feedback.count,
      retained: feedback.count,
      note: 'Free-text comments scrubbed; ratings retained.',
    };

    // 7. Performance reviews — the subject's own self-evaluation free text is
    //    scrubbed; manager ratings are retained as tribunal evidence under
    //    Art. 17(3)(e).
    const reviews = await tx.performanceReview.updateMany({
      where: { employeeId },
      data: { selfAchievements: null, selfImprovements: null },
    });
    inventory.performanceReviews = {
      scrubbed: reviews.count,
      retained: reviews.count,
      note: 'Self-evaluation free text cleared; manager ratings/feedback retained (legal-claims basis).',
    };

    // 8. Roster notes — free-text notes scrubbed; schedule rows retained.
    const rosterNotes = await tx.rosterEntry.updateMany({
      where: { employeeId, notes: { not: null } },
      data: { notes: null },
    });
    inventory.rosterNotes = {
      scrubbed: rosterNotes.count,
      retained: 0,
      note: 'Roster note text cleared; schedule rows retained.',
    };

    return inventory;
  }

  async create(dto: CreateEmployeeDto, actorId?: string, actorEmail?: string) {
    const existing = await this.prisma.employee.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException(`Employee with email ${dto.email} already exists`);
    }

    // Auto-generate employee number — race-free via the employee_number_seq
    // Postgres sequence (migration 20261005140000_employee_number_seq),
    // formatted with the shared EMP-YYYY-NNNN helper. nextval() is atomic:
    // concurrent creations can never collide (go-live Phase 1 item 6).
    const employeeNumber = await nextEmployeeNumber((sql: string) =>
      this.prisma.$queryRawUnsafe(sql),
    );

    // Phase 2 item 3 — extended profile (columns via worker 4 migration;
    // unmigrated columns are skipped, not fatal).
    const extended = await pickKnownColumns(
      this.prisma,
      'employees',
      buildExtendedProfileData(dto),
      'EmployeesService.create',
    );

    const employee = await this.prisma.employee.create({
      data: {
        employeeNumber,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email.toLowerCase(),
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender as any,
        address: dto.address,
        departmentId: dto.departmentId,
        designationId: dto.designationId,
        managerId: dto.managerId,
        joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : new Date(),
        status: (dto.status as any) || 'FULL_TIME',
        profileSummary: dto.profileSummary,
        avatarUrl: dto.avatarUrl,
        ...extended,
      } as any,
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'EMPLOYEE',
      entityId: employee.id,
      afterState: employee,
    });

    return employee;
  }

  /**
   * A1: policy-scoped update. HR/SUPER_ADMIN may edit anyone with the full
   * DTO; MANAGERs may edit their DIRECT REPORTS ONLY and only the
   * MANAGER_EDITABLE_FIELDS allowlist — role/status/email (and every other
   * non-allowlisted field) is rejected with 400, enforced here in the
   * service as well as by the DTO shape.
   */
  async updateScoped(id: string, dto: UpdateEmployeeDto, viewer: EmployeeViewer) {
    const hr = isHrOrAdmin(viewer.roles);
    const allowed = await this.accessPolicy.can(
      { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
      id,
      'edit',
    );
    if (!allowed) {
      throw new ForbiddenException('You do not have permission to edit this employee profile');
    }

    if (!hr) {
      const editable = MANAGER_EDITABLE_FIELDS as readonly string[];
      const forbidden = Object.keys(dto).filter((k) => !editable.includes(k));
      if (forbidden.length > 0) {
        throw new BadRequestException(
          `You do not have permission to change: ${forbidden.join(', ')}. ` +
            'Contact HR for identity, employment-term or compensation changes.',
        );
      }
    }

    return this.update(id, dto, viewer.userId);
  }

  async update(id: string, dto: Partial<UpdateEmployeeDto>, actorId?: string, actorEmail?: string) {
    const existing = await this.findOne(id);

    // Track historical changes in department or designation
    const deptChanged = dto.departmentId && dto.departmentId !== existing.departmentId;
    const desigChanged = dto.designationId && dto.designationId !== existing.designationId;

    if (deptChanged || desigChanged) {
      await this.prisma.employeeEmploymentHistory.create({
        data: {
          employeeId: id,
          previousDepartment: existing.department?.name,
          previousDesignation: existing.designation?.title,
          reason: 'Department or designation reassignment',
        },
      });
    }

    const updated = await this.prisma.employee.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ? dto.email.toLowerCase() : undefined,
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender as any,
        address: dto.address,
        departmentId: dto.departmentId,
        designationId: dto.designationId,
        managerId: dto.managerId,
        joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
        status: dto.status as any,
        profileSummary: dto.profileSummary,
        avatarUrl: dto.avatarUrl,
        // Phase 2 item 3 — extended profile (columns via worker 4 migration;
        // unmigrated columns are skipped, not fatal).
        ...(await pickKnownColumns(
          this.prisma,
          'employees',
          buildExtendedProfileData(dto),
          'EmployeesService.update',
        )),
      } as any,
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'EMPLOYEE',
      entityId: id,
      beforeState: existing,
      afterState: updated,
    });

    return updated;
  }

  async remove(id: string, actorId?: string, actorEmail?: string) {
    const existing = await this.findOne(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'TERMINATED' },
      });

      if (existing.userId) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { isActive: false, deletedAt: new Date() },
        });
      }
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.DELETE,
      entityType: 'EMPLOYEE',
      entityId: id,
      beforeState: existing,
    });

    return { message: 'Employee successfully deactivated and soft deleted' };
  }

  async getAuditLogs(employeeId: string) {
    return this.audit.getLogs('EMPLOYEE', employeeId);
  }

  async getMyProfile(userId: string, employeeId?: string) {
    let empId = employeeId;
    if (!empId) {
      const emp = await this.prisma.employee.findFirst({
        where: { userId, deletedAt: null },
      });
      if (!emp) {
        throw new NotFoundException('No employee record linked to current user account');
      }
      empId = emp.id;
    }
    return this.findOne(empId);
  }

  async updateMyAvatar(
    userId: string,
    employeeId: string | undefined,
    avatarUrl: string | null | undefined,
    actorEmail?: string,
  ) {
    let empId = employeeId;
    if (!empId) {
      const emp = await this.prisma.employee.findFirst({
        where: { userId, deletedAt: null },
      });
      if (!emp) {
        throw new NotFoundException('No employee record linked to current user account');
      }
      empId = emp.id;
    }

    const existing = await this.prisma.employee.findUnique({
      where: { id: empId },
    });

    if (!existing) {
      throw new NotFoundException('Employee not found');
    }

    const rawAvatarUrl = avatarUrl && avatarUrl.trim().length > 0 ? avatarUrl.trim() : null;

    // Go-live Phase 3 item 8: base64 avatars move to object storage instead of
    // bloating the employees row. Anything already a key/URL passes through.
    let cleanAvatarUrl: string | null = rawAvatarUrl;
    const dataUrlMatch = rawAvatarUrl?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (dataUrlMatch) {
      const [, mimeType, b64] = dataUrlMatch;
      const buffer = Buffer.from(b64, 'base64');
      const { key } = await this.avatars.uploadAvatar(empId, buffer, mimeType);
      cleanAvatarUrl = key;
      // Best-effort cleanup of the previous object-storage avatar.
      if (existing.avatarUrl?.startsWith('avatars/')) {
        await this.avatars.deleteAvatar(existing.avatarUrl).catch((err) => {
          this.logger.warn(`Failed to delete replaced avatar ${existing.avatarUrl}: ${err?.message}`);
        });
      }
    } else if (rawAvatarUrl === null && existing.avatarUrl?.startsWith('avatars/')) {
      await this.avatars.deleteAvatar(existing.avatarUrl).catch((err) => {
        this.logger.warn(`Failed to delete removed avatar ${existing.avatarUrl}: ${err?.message}`);
      });
    }

    const updated = await this.prisma.employee.update({
      where: { id: empId },
      data: { avatarUrl: cleanAvatarUrl },
    });

    await this.audit.log({
      actorId: userId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'EMPLOYEE_AVATAR',
      entityId: empId,
      beforeState: { avatarUrl: existing.avatarUrl },
      afterState: { avatarUrl: updated.avatarUrl },
    });

    this.logger.log(`Employee ${empId} (${existing.email}) updated avatar picture`);

    return {
      success: true,
      message: cleanAvatarUrl
        ? 'Profile picture updated successfully'
        : 'Profile picture removed successfully',
      data: {
        employeeId: updated.id,
        avatarUrl: await this.resolveAvatarUrl(updated.avatarUrl),
      },
    };
  }

  /**
   * Resolve the current employee's stored avatar to a client-usable URL
   * (presigned when it lives in object storage).
   */
  async getMyAvatarUrl(userId: string, employeeId?: string): Promise<{ avatarUrl: string | null }> {
    let empId = employeeId;
    if (!empId) {
      const emp = await this.prisma.employee.findFirst({
        where: { userId, deletedAt: null },
        select: { id: true },
      });
      if (!emp) {
        throw new NotFoundException('No employee record linked to current user account');
      }
      empId = emp.id;
    }
    const emp = await this.prisma.employee.findUnique({
      where: { id: empId },
      select: { avatarUrl: true },
    });
    return { avatarUrl: await this.resolveAvatarUrl(emp?.avatarUrl) };
  }
}
