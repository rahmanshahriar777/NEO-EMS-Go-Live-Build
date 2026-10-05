import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { tableExists, pickKnownColumns } from '../../core/prisma/schema-compat.util';
import { AuditAction, SystemRole, nextEmployeeNumber, formatEmployeeNumber } from '@ems/shared';
import {
  CreateVacancyDto,
  CreateCandidateDto,
  UpdateCandidateStageDto,
  CreateOfferDto,
} from './dto/recruitment.dto';

export interface RecruitmentViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

function isHrOrAdmin(roles: string[]): boolean {
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

/**
 * Schema need (worker 4) — new models (Phase 3, item 8):
 *
 *   model Vacancy {
 *     id String @id @default(uuid()); title String; description String?;
 *     departmentId String?; designationId String?;
 *     status VacancyStatus @default(OPEN); // OPEN | ON_HOLD | CLOSED
 *     postedAt DateTime @default(now()); closedAt DateTime?;
 *     createdById String?; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
 *     candidates Candidate[];
 *     @@map("vacancies")
 *   }
 *   model Candidate {
 *     id String @id @default(uuid()); vacancyId String;
 *     firstName String; lastName String; email String; phone String?;
 *     resumeDocumentId String?;
 *     stage CandidateStage @default(APPLIED); // APPLIED | SCREENING | INTERVIEW | OFFER | HIRED | REJECTED
 *     notes Json @default("[]");
 *     employeeId String?; // set when an offer is accepted and an employee is auto-created
 *     createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
 *     vacancy Vacancy @relation(fields: [vacancyId], references: [id], onDelete: Cascade);
 *     offers Offer[];
 *     @@index([vacancyId, stage]); @@map("candidates")
 *   }
 *   model Offer {
 *     id String @id @default(uuid()); candidateId String;
 *     status OfferStatus @default(DRAFT); // DRAFT | SENT | ACCEPTED | DECLINED | WITHDRAWN
 *     startDate DateTime?; salaryAmount Decimal?; terms String?;
 *     sentAt DateTime?; decidedAt DateTime?;
 *     createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
 *     candidate Candidate @relation(fields: [candidateId], references: [id], onDelete: Cascade);
 *     @@map("offers")
 *   }
 */
@Injectable()
export class RecruitmentService {
  private readonly logger = new Logger(RecruitmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async requireTables(): Promise<void> {
    const ok =
      (await tableExists(this.prisma, 'vacancies')) &&
      (await tableExists(this.prisma, 'candidates')) &&
      (await tableExists(this.prisma, 'offers'));
    if (!ok) {
      throw new ServiceUnavailableException(
        'Recruitment requires the Vacancy/Candidate/Offer migration (worker 4).',
      );
    }
  }

  private db(): any {
    return this.prisma as any;
  }

  private requireHr(viewer: RecruitmentViewer): void {
    if (!isHrOrAdmin(viewer.roles)) {
      throw new ForbiddenException('Recruitment management is limited to HR/admin');
    }
  }

  // ---------------------------------------------------------------------------
  // Vacancies
  // ---------------------------------------------------------------------------

  async listVacancies(status?: string) {
    await this.requireTables();
    return this.db().vacancy.findMany({
      where: status ? { status } : undefined,
      include: { _count: { select: { candidates: true } } },
      orderBy: { postedAt: 'desc' },
    });
  }

  async createVacancy(dto: CreateVacancyDto, viewer: RecruitmentViewer) {
    await this.requireTables();
    this.requireHr(viewer);
    const vacancy = await this.db().vacancy.create({
      data: {
        title: dto.title,
        description: dto.description ?? null,
        departmentId: dto.departmentId ?? null,
        designationId: dto.designationId ?? null,
        status: (dto.status as any) ?? 'OPEN',
        createdById: viewer.userId,
      },
    });
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'VACANCY',
      entityId: vacancy.id,
      afterState: { id: vacancy.id, title: vacancy.title },
    });
    return vacancy;
  }

  // ---------------------------------------------------------------------------
  // Candidates
  // ---------------------------------------------------------------------------

  async addCandidate(dto: CreateCandidateDto, viewer: RecruitmentViewer) {
    await this.requireTables();
    this.requireHr(viewer);

    const vacancy = await this.db().vacancy.findUnique({ where: { id: dto.vacancyId } });
    if (!vacancy) throw new NotFoundException('Vacancy not found');
    if (vacancy.status !== 'OPEN') {
      throw new BadRequestException('Cannot add candidates to a closed vacancy');
    }

    const candidate = await this.db().candidate.create({
      data: {
        vacancyId: dto.vacancyId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone ?? null,
        resumeDocumentId: dto.resumeDocumentId ?? null,
        stage: 'APPLIED',
      },
    });
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'CANDIDATE',
      entityId: candidate.id,
      afterState: { id: candidate.id, vacancyId: dto.vacancyId, email: dto.email },
    });
    return candidate;
  }

  async listCandidates(vacancyId: string, stage?: string, viewer?: RecruitmentViewer) {
    await this.requireTables();
    if (viewer) this.requireHr(viewer);
    return this.db().candidate.findMany({
      where: { vacancyId, ...(stage && { stage: stage as any }) },
      include: { offers: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateCandidateStage(id: string, dto: UpdateCandidateStageDto, viewer: RecruitmentViewer) {
    await this.requireTables();
    this.requireHr(viewer);
    const candidate = await this.db().candidate.findUnique({ where: { id } });
    if (!candidate) throw new NotFoundException('Candidate not found');
    if (candidate.stage === 'HIRED' || candidate.stage === 'REJECTED') {
      throw new BadRequestException('Candidate pipeline is closed for this applicant');
    }

    const updated = await this.db().candidate.update({
      where: { id },
      data: { stage: dto.stage as any },
    });
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.UPDATE,
      entityType: 'CANDIDATE',
      entityId: id,
      beforeState: { stage: candidate.stage },
      afterState: { stage: dto.stage, note: dto.note ?? null },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Offers + auto-create employee
  // ---------------------------------------------------------------------------

  async createOffer(candidateId: string, dto: CreateOfferDto, viewer: RecruitmentViewer) {
    await this.requireTables();
    this.requireHr(viewer);
    const candidate = await this.db().candidate.findUnique({
      where: { id: candidateId },
      include: { vacancy: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');

    const offer = await this.db().offer.create({
      data: {
        candidateId,
        status: 'DRAFT',
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        salaryAmount: dto.salaryAmount != null ? String(dto.salaryAmount) : null,
        terms: dto.terms ?? null,
      },
    });
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'OFFER',
      entityId: offer.id,
      afterState: { candidateId, startDate: dto.startDate },
    });
    return offer;
  }

  /**
   * Accept an offer: marks it ACCEPTED, moves the candidate to HIRED, and
   * auto-creates an Employee record from the candidate's details. The new
   * employee is PENDING/onboarding until HR completes setup — it gets a
   * generated employeeNumber and no User account yet (identity provisioning
   * is handled by worker 1's auth flows).
   */
  async acceptOffer(offerId: string, viewer: RecruitmentViewer) {
    await this.requireTables();
    this.requireHr(viewer);

    const offer = await this.db().offer.findUnique({
      where: { id: offerId },
      include: { candidate: true },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.status !== 'DRAFT' && offer.status !== 'SENT') {
      throw new BadRequestException('Only draft/sent offers can be accepted');
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      const accepted = await tx.offer.update({
        where: { id: offerId },
        data: { status: 'ACCEPTED', decidedAt: new Date() },
      });
      await tx.candidate.update({
        where: { id: offer.candidateId },
        data: { stage: 'HIRED' },
      });

      // Auto-create the employee record from candidate details.
      const candidate = offer.candidate;
      const employeeNumber = await this.generateEmployeeNumber(tx);
      // v4 fix #9: the offer's startDate is the joining date — default
      // contractStart from it so a mid-month joiner is prorated, not paid a
      // full month, once HR activates the record. One clock read so both
      // dates always agree.
      const startDate = offer.startDate ?? new Date();
      const employee = await tx.employee.create({
        data: await pickKnownColumns(
          tx,
          'employees',
          {
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            email: candidate.email,
            phone: candidate.phone ?? null,
            employeeNumber,
            status: 'PENDING',
            joiningDate: startDate,
            contractStart: startDate,
          },
          'RecruitmentService.acceptOffer',
        ),
      });
      await tx.candidate.update({
        where: { id: offer.candidateId },
        data: { employeeId: employee.id },
      });
      return { accepted, employee };
    });

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.UPDATE,
      entityType: 'OFFER',
      entityId: offerId,
      beforeState: { status: offer.status },
      afterState: {
        status: 'ACCEPTED',
        candidateId: offer.candidateId,
        employeeId: result.employee.id,
      },
    });

    try {
      await this.notifications.createNotification(
        viewer.userId,
        'Offer accepted',
        `${offer.candidate.firstName} ${offer.candidate.lastName} accepted the offer. Employee record created: ${result.employee.employeeNumber}.`,
        '/onboarding/checklists',
      );
    } catch (e: any) {
      this.logger.warn(`Offer-accepted notification failed (fail-open): ${e.message}`);
    }

    return result;
  }

  /**
   * Employee number generator — shared sequence + EMP-YYYY-NNNN format
   * (go-live Phase 1 item 6). Falls back to a MAX()-suffix probe ONLY when the
   * sequence is not yet migrated; the fallback parses BOTH the canonical
   * EMP-YYYY-NNNN and the legacy EMP-NNNNN shapes so the two historic
   * formats never collide with each other.
   */
  private async generateEmployeeNumber(tx: any): Promise<string> {
    try {
      return await nextEmployeeNumber((sql: string) => tx.$queryRawUnsafe(sql));
    } catch {
      /* sequence not yet migrated — fall through to MAX() probe */
    }
    const rows: any[] = await tx.$queryRawUnsafe(
      `SELECT "employeeNumber" FROM employees WHERE "employeeNumber" ~ '^EMP-([0-9]{4}-)?[0-9]+$' ORDER BY "employeeNumber" DESC LIMIT 1`,
    );
    const current = (rows as any)?.[0]?.employeeNumber as string | undefined;
    const match = current ? /(\d+)$/.exec(current) : null;
    const next = match ? parseInt(match[1], 10) + 1 : 1;
    return formatEmployeeNumber(new Date().getFullYear(), next);
  }
}
