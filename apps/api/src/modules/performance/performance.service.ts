import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { tableExists } from '../../core/prisma/schema-compat.util';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateReviewCycleDto,
  CreatePerformanceReviewDto,
  SubmitSelfReviewDto,
  SubmitManagerReviewDto,
  CreateGoalDto,
  UpdateGoalDto,
  SubmitFeedbackDto,
  CreateReviewFormDto,
} from './dto/performance.dto';
import { ReviewStatus, AuditAction, SystemRole, JwtPayload } from '@ems/shared';

export interface PerformanceViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

export function toPerformanceViewer(user: JwtPayload): PerformanceViewer {
  return { userId: user.sub, employeeId: user.employeeId, roles: user.roles };
}

function isHrOrAdmin(roles: string[]): boolean {
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

/** Terminal review states: locked against further submissions (A3, Phase 2 item 9). */
const LOCKED_REVIEW_STATUSES = [ReviewStatus.COMPLETED, ReviewStatus.ARCHIVED];

/**
 * Built-in review form (Phase 2, item 9). Served when the ReviewForm table is
 * unmigrated/empty so the UI can always render a review form. Persisted forms
 * (HR-managed) take precedence once the table exists.
 */
export const DEFAULT_REVIEW_FORM = {
  id: 'default',
  title: 'Standard Performance Review',
  description: 'Default review form: ratings 1–5 plus narrative sections.',
  sections: [
    {
      key: 'performance',
      title: 'Job Performance',
      questions: [
        { key: 'quality', label: 'Quality of work', type: 'rating', required: true },
        { key: 'productivity', label: 'Productivity & efficiency', type: 'rating', required: true },
        { key: 'reliability', label: 'Reliability & attendance', type: 'rating', required: true },
      ],
    },
    {
      key: 'competencies',
      title: 'Competencies',
      questions: [
        { key: 'teamwork', label: 'Teamwork & collaboration', type: 'rating', required: true },
        { key: 'communication', label: 'Communication', type: 'rating', required: true },
        { key: 'initiative', label: 'Initiative & ownership', type: 'rating', required: false },
      ],
    },
    {
      key: 'narrative',
      title: 'Narrative',
      questions: [
        { key: 'achievements', label: 'Key achievements', type: 'textarea', required: true },
        { key: 'improvements', label: 'Areas for improvement', type: 'textarea', required: true },
      ],
    },
  ],
  isActive: true,
};

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
    // Optional: notification centre hook (Phase 2 item 2). @Optional so this
    // service still constructs in unit tests that don't provide it.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Review Cycles
  // ---------------------------------------------------------------------------

  async getCycles() {
    return this.prisma.performanceReviewCycle.findMany({
      include: {
        _count: { select: { reviews: true } },
      },
      orderBy: { startDate: 'desc' },
    });
  }

  async createCycle(dto: CreateReviewCycleDto, actorId?: string, actorEmail?: string) {
    const cycle = await this.prisma.performanceReviewCycle.create({
      data: {
        title: dto.title,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        description: dto.description,
        isActive: true,
      },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'PERFORMANCE_CYCLE',
      entityId: cycle.id,
      afterState: cycle,
    });

    return cycle;
  }

  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------

  /**
   * A6: scoped review listing. HR/admin may filter freely; everyone else sees
   * their own reviews plus their direct reports'. Callers with no linked
   * employee profile get an empty array (unless HR) — never the full table.
   */
  async getReviews(viewer: PerformanceViewer, employeeId?: string, cycleId?: string) {
    const hr = isHrOrAdmin(viewer.roles);

    let where: any = { ...(cycleId && { cycleId }) };

    if (hr) {
      if (employeeId) where.employeeId = employeeId;
    } else {
      if (!viewer.employeeId) return [];
      if (employeeId && employeeId !== viewer.employeeId) {
        const ok = await this.accessPolicy.can(
          { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
          employeeId,
          'view',
        );
        if (!ok) return [];
        where.employeeId = employeeId;
      } else {
        const reports = await this.prisma.employee.findMany({
          where: { managerId: viewer.employeeId, deletedAt: null },
          select: { id: true },
        });
        where.employeeId = { in: [viewer.employeeId, ...reports.map((r) => r.id)] };
      }
    }

    return this.prisma.performanceReview.findMany({
      where,
      include: {
        cycle: true,
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeNumber: true, email: true },
        },
        reviewer: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Legacy unscoped signature kept for internal callers (HR-only paths). */
  async getReviewsUnscoped(employeeId?: string, cycleId?: string) {
    return this.getReviews(
      { userId: 'system', roles: [SystemRole.HR_ADMIN] },
      employeeId,
      cycleId,
    );
  }

  async createReview(dto: CreatePerformanceReviewDto, viewer?: PerformanceViewer) {
    const existing = await this.prisma.performanceReview.findUnique({
      where: {
        cycleId_employeeId: {
          cycleId: dto.cycleId,
          employeeId: dto.employeeId,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('A review has already been initiated for this employee in this cycle');
    }

    // Non-HR initiators may only start reviews for their direct reports.
    if (viewer && !isHrOrAdmin(viewer.roles)) {
      const ok = await this.accessPolicy.can(
        { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
        dto.employeeId,
        'review',
      );
      if (!ok) {
        throw new ForbiddenException('You can only initiate reviews for your direct reports');
      }
    }

    // Auto-assign employee manager as reviewer if not specified
    let reviewerId = dto.reviewerId;
    if (!reviewerId) {
      const emp = await this.prisma.employee.findUnique({ where: { id: dto.employeeId } });
      reviewerId = emp?.managerId || undefined;
    }

    const created = await this.prisma.performanceReview.create({
      data: {
        cycleId: dto.cycleId,
        employeeId: dto.employeeId,
        reviewerId,
        status: ReviewStatus.DRAFT as any,
      },
      include: { employee: true, reviewer: true, cycle: true },
    });

    await this.audit.log({
      actorId: viewer?.userId,
      action: AuditAction.CREATE,
      entityType: 'PERFORMANCE_REVIEW',
      entityId: created.id,
      afterState: { id: created.id, employeeId: dto.employeeId, reviewerId, cycleId: dto.cycleId },
    });

    return created;
  }

  async submitSelfReview(reviewId: string, employeeId: string, dto: SubmitSelfReviewDto) {
    const review = await this.prisma.performanceReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Performance review not found');

    if (review.employeeId !== employeeId) {
      throw new ForbiddenException('Cannot submit self evaluation for another employee');
    }

    // Phase 2 item 9: completed/archived reviews are locked.
    if ((LOCKED_REVIEW_STATUSES as string[]).includes(review.status as string)) {
      throw new ConflictException(`Cannot modify a ${review.status} review`);
    }

    return this.prisma.performanceReview.update({
      where: { id: reviewId },
      data: {
        selfRating: dto.selfRating,
        selfAchievements: dto.selfAchievements,
        selfImprovements: dto.selfImprovements,
        status: ReviewStatus.SELF_REVIEW_SUBMITTED as any,
      },
    });
  }

  /**
   * A3: manager review. The caller must be the ASSIGNED reviewer (or the
   * employee's line manager when no reviewer was assigned); completed or
   * archived reviews cannot be overwritten; nobody can review themselves.
   */
  async submitManagerReview(
    reviewId: string,
    reviewerEmployeeId: string,
    dto: SubmitManagerReviewDto,
    reviewer?: PerformanceViewer,
  ) {
    const review = await this.prisma.performanceReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Performance review not found');

    // Cannot overwrite a completed/archived review (status workflow lock).
    if ((LOCKED_REVIEW_STATUSES as string[]).includes(review.status as string)) {
      throw new ConflictException(
        `Cannot modify a ${review.status} review — it is locked`,
      );
    }

    // Nobody reviews themselves.
    if (review.employeeId === reviewerEmployeeId) {
      throw new ForbiddenException('You cannot submit a manager review for yourself');
    }

    // Must be the assigned reviewer — or the line manager when unassigned.
    if (review.reviewerId) {
      if (review.reviewerId !== reviewerEmployeeId) {
        throw new ForbiddenException('Only the assigned reviewer can submit the manager review');
      }
    } else {
      const emp = await this.prisma.employee.findUnique({
        where: { id: review.employeeId },
        select: { managerId: true },
      });
      const hr = reviewer ? isHrOrAdmin(reviewer.roles) : false;
      if (!hr && emp?.managerId !== reviewerEmployeeId) {
        throw new ForbiddenException(
          'Only the assigned reviewer or the employee\u2019s line manager can submit the manager review',
        );
      }
    }

    // Calculate final weighted score if not explicitly set
    let finalScore = dto.finalScore;
    if (!finalScore && review.selfRating) {
      finalScore = Number(((Number(review.selfRating) * 0.4) + (dto.managerRating * 0.6)).toFixed(2));
    } else if (!finalScore) {
      finalScore = dto.managerRating;
    }

    return this.prisma.performanceReview.update({
      where: { id: reviewId },
      data: {
        reviewerId: reviewerEmployeeId,
        managerRating: dto.managerRating,
        managerFeedback: dto.managerFeedback,
        finalScore,
        status: ReviewStatus.COMPLETED as any,
      },
    }).then(async (completed) => {
      await this.audit.log({
        actorId: reviewer?.userId,
        action: AuditAction.UPDATE,
        entityType: 'PERFORMANCE_REVIEW',
        entityId: reviewId,
        beforeState: { status: review.status },
        afterState: { status: ReviewStatus.COMPLETED, finalScore },
      });
      // Notification centre hook (Phase 2 item 2): tell the employee their
      // review is complete. Fail-open.
      await this.notifyReviewCompleted(completed);
      return completed;
    });
  }

  // ---------------------------------------------------------------------------
  // Review forms (Phase 2, item 9)
  //
  // Schema need (worker 4) — new model ReviewForm:
  //   id String @id @default(uuid()); title String; description String?;
  //   sections Json; isActive Boolean @default(true);
  //   createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
  //   @@map("review_forms")
  // ---------------------------------------------------------------------------

  /** HR-managed forms; falls back to the built-in default form. */
  async getReviewForms() {
    if (await tableExists(this.prisma, 'review_forms')) {
      const forms = await (this.prisma as any).reviewForm.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (forms.length > 0) return forms;
    }
    return [{ ...DEFAULT_REVIEW_FORM, note: 'Built-in default (ReviewForm table unmigrated or empty)' }];
  }

  async getReviewForm(id: string) {
    if (id === 'default' || !(await tableExists(this.prisma, 'review_forms'))) {
      return DEFAULT_REVIEW_FORM;
    }
    const form = await (this.prisma as any).reviewForm.findUnique({ where: { id } });
    if (!form) throw new NotFoundException('Review form not found');
    return form;
  }

  async createReviewForm(dto: CreateReviewFormDto, actorId?: string, actorEmail?: string) {
    if (!(await tableExists(this.prisma, 'review_forms'))) {
      throw new ServiceUnavailableException(
        'Review forms require the ReviewForm migration (worker 4).',
      );
    }
    const form = await (this.prisma as any).reviewForm.create({
      data: {
        title: dto.title,
        description: dto.description,
        sections: dto.sections,
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'REVIEW_FORM',
      entityId: form.id,
      afterState: { id: form.id, title: form.title },
    });
    return form;
  }

  // ---------------------------------------------------------------------------
  // Goals
  // ---------------------------------------------------------------------------

  async getGoals(employeeId: string) {
    return this.prisma.goal.findMany({
      where: { employeeId },
      orderBy: { targetDate: 'asc' },
    });
  }

  /**
   * A4: scoped goal listing. A foreign employeeId is denied with 409
   * ("ignore-or-409" — explicit denial, not silent filtering, so callers
   * know the parameter was rejected).
   */
  async getGoalsScoped(viewer: PerformanceViewer, employeeId?: string) {
    const target = employeeId ?? viewer.employeeId;
    if (!target) {
      throw new ForbiddenException('Employee profile required');
    }
    if (!isHrOrAdmin(viewer.roles) && target !== viewer.employeeId) {
      const ok = await this.accessPolicy.can(
        { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
        target,
        'view',
      );
      if (!ok) {
        throw new ConflictException(
          'Cannot list goals for another employee outside your team',
        );
      }
    }
    return this.getGoals(target);
  }

  async createGoal(employeeId: string, dto: CreateGoalDto) {
    return this.prisma.goal.create({
      data: {
        employeeId: dto.employeeId || employeeId,
        title: dto.title,
        description: dto.description,
        targetDate: new Date(dto.targetDate),
        progress: dto.progress || 0,
        status: (dto.status as any) || 'NOT_STARTED',
      },
    });
  }

  /**
   * A4: scoped goal creation. Creating a goal for someone else requires the
   * policy's edit grant (self, direct report, or HR); otherwise 409.
   */
  async createGoalScoped(viewer: PerformanceViewer, dto: CreateGoalDto) {
    if (!viewer.employeeId) {
      throw new ForbiddenException('Employee profile required');
    }
    const target = dto.employeeId ?? viewer.employeeId;
    if (!isHrOrAdmin(viewer.roles) && target !== viewer.employeeId) {
      const ok = await this.accessPolicy.can(
        { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
        target,
        'edit',
      );
      if (!ok) {
        throw new ConflictException('Cannot create goals for another employee outside your team');
      }
    }
    const created = await this.createGoal(target, { ...dto, employeeId: target });
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'GOAL',
      entityId: created.id,
      afterState: { id: created.id, employeeId: target, title: created.title },
    });
    return created;
  }

  async updateGoal(id: string, employeeId: string, dto: UpdateGoalDto, viewer?: PerformanceViewer) {
    const goal = await this.prisma.goal.findUnique({ where: { id } });
    if (!goal) throw new NotFoundException('Goal not found');

    // Owner, or the owner's manager/HR via the access policy.
    if (goal.employeeId !== employeeId) {
      const roles = viewer?.roles ?? [];
      if (!isHrOrAdmin(roles)) {
        const ok = viewer?.employeeId
          ? await this.accessPolicy.can(
              { userId: viewer.userId, roles, employeeId: viewer.employeeId },
              goal.employeeId,
              'edit',
            )
          : false;
        if (!ok) {
          throw new ForbiddenException('Cannot update another employee goal');
        }
      }
    }

    let status = dto.status as any;
    if (dto.progress !== undefined && dto.progress >= 100) {
      status = 'COMPLETED';
    }

    const updated = await this.prisma.goal.update({
      where: { id },
      data: {
        progress: dto.progress,
        status,
        description: dto.description,
      },
    });

    await this.audit.log({
      actorId: viewer?.userId,
      action: AuditAction.UPDATE,
      entityType: 'GOAL',
      entityId: id,
      beforeState: { progress: goal.progress, status: goal.status },
      afterState: { progress: updated.progress, status: updated.status },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Feedback
  // ---------------------------------------------------------------------------

  async getFeedback(recipientId: string) {
    return this.prisma.feedback.findMany({
      where: { recipientId },
      include: {
        sender: {
          select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submitFeedback(senderId: string, dto: SubmitFeedbackDto) {
    return this.prisma.feedback.create({
      data: {
        senderId,
        recipientId: dto.recipientId,
        type: dto.type as any,
        comments: dto.comments,
        rating: dto.rating,
      },
    });
  }

  /**
   * Notification centre hook (Phase 2 item 2). Fail-open: notification
   * failures must never roll back the completed review.
   */
  private async notifyReviewCompleted(review: any): Promise<void> {
    if (!this.notifications) return;
    try {
      const employee = await this.prisma.employee.findUnique({
        where: { id: review.employeeId },
        select: { userId: true, email: true, firstName: true, lastName: true },
      });
      if (!employee?.userId) {
        this.logger.debug(
          `No user linked for employee ${review.employeeId}; skipping review-completed notification`,
        );
        return;
      }
      await this.notifications.notify({
        userId: employee.userId,
        template: 'review-completed',
        title: 'Performance review completed',
        message: `Your performance review has been completed${review.finalScore != null ? ` with a final score of ${review.finalScore}` : ''}.`,
        linkUrl: `/performance/reviews/${review.id}`,
        idempotencyKey: `review-completed:${review.id}`,
        emailCopy: true,
        emailTo: employee.email ?? undefined,
      });
    } catch (e: any) {
      this.logger.warn(`review-completed notification failed (fail-open): ${e.message}`);
    }
  }
}
