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
import { tableExists } from '../../core/prisma/schema-compat.util';
import { AuditAction, SystemRole } from '@ems/shared';
import { CreateChecklistDto, CompleteTaskDto, AssignTaskDto } from './dto/onboarding.dto';

export interface OnboardingViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

function isHrOrAdmin(roles: string[]): boolean {
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

/**
 * Schema need (worker 4) — new models:
 *
 *   model OnboardingChecklist {
 *     id String @id @default(uuid()); employeeId String;
 *     kind OnboardingKind; // ONBOARDING | OFFBOARDING (enum)
 *     status ChecklistStatus @default(IN_PROGRESS); // IN_PROGRESS | COMPLETED | CANCELLED
 *     referenceDate DateTime?; createdById String?;
 *     createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
 *     tasks OnboardingTask[];
 *     @@index([employeeId, kind]); @@map("onboarding_checklists")
 *   }
 *   model OnboardingTask {
 *     id String @id @default(uuid()); checklistId String;
 *     title String; description String?; ownerRole String @default("HR");
 *     ownerUserId String?; dueDate DateTime?;
 *     status TaskStatus @default(PENDING); // PENDING | IN_PROGRESS | DONE | SKIPPED
 *     completedAt DateTime?; completedById String?;
 *     note String?; documentId String?;
 *     createdAt DateTime @default(now()); updatedAt DateTime @updatedAt;
 *     checklist OnboardingChecklist @relation(fields: [checklistId], references: [id], onDelete: Cascade);
 *     @@index([checklistId, status]); @@map("onboarding_tasks")
 *   }
 *
 * Until the migration lands, every method throws ServiceUnavailableException
 * naming the migration — checklists must not live in a half-migrated store.
 */

/** Default onboarding task set (used when the caller supplies no tasks). */
export const DEFAULT_ONBOARDING_TASKS = [
  { title: 'Sign employment contract', description: 'Collect the signed contract', ownerRole: 'HR', dueDayOffset: 0 },
  { title: 'Collect right-to-work documents', description: 'Passport / visa / work permit', ownerRole: 'HR', dueDayOffset: 1 },
  { title: 'Set up workstation & accounts', description: 'Laptop, email, system access', ownerRole: 'IT', dueDayOffset: 1 },
  { title: 'Complete HR induction', description: 'Policies, handbook acknowledgement', ownerRole: 'HR', dueDayOffset: 3 },
  { title: 'Meet the team & manager 1:1', description: 'Introductions and role expectations', ownerRole: 'MANAGER', dueDayOffset: 2 },
  { title: 'Complete mandatory training', description: 'Health & safety, data protection', ownerRole: 'EMPLOYEE', dueDayOffset: 7 },
];

/** Default offboarding task set: exit steps incl. equipment handover. */
export const DEFAULT_OFFBOARDING_TASKS = [
  { title: 'Return equipment', description: 'Laptop, badge, keys — equipment handover', ownerRole: 'IT', dueDayOffset: 0 },
  { title: 'Revoke system access', description: 'Disable accounts on the last day', ownerRole: 'IT', dueDayOffset: 0 },
  { title: 'Conduct exit interview', description: 'HR exit interview', ownerRole: 'HR', dueDayOffset: -1 },
  { title: 'Hand over work', description: 'Knowledge transfer to the team', ownerRole: 'EMPLOYEE', dueDayOffset: -3 },
  { title: 'Collect final documents', description: 'P45 / payslips / references', ownerRole: 'HR', dueDayOffset: 5 },
  { title: 'Settle final payroll', description: 'Confirm final pay run includes the leaver', ownerRole: 'HR', dueDayOffset: 5 },
];

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async requireTables(): Promise<void> {
    const ok =
      (await tableExists(this.prisma, 'onboarding_checklists')) &&
      (await tableExists(this.prisma, 'onboarding_tasks'));
    if (!ok) {
      throw new ServiceUnavailableException(
        'Onboarding checklists require the OnboardingChecklist/OnboardingTask migration (worker 4).',
      );
    }
  }

  private db(): any {
    return this.prisma as any;
  }

  /** HR/admin: start an onboarding or offboarding checklist for an employee. */
  async createChecklist(dto: CreateChecklistDto, viewer: OnboardingViewer) {
    await this.requireTables();
    if (!isHrOrAdmin(viewer.roles)) {
      throw new ForbiddenException('Only HR/admin can start checklists');
    }

    const templates = dto.tasks?.length
      ? dto.tasks
      : dto.kind === 'ONBOARDING'
        ? DEFAULT_ONBOARDING_TASKS
        : DEFAULT_OFFBOARDING_TASKS;

    const referenceDate = dto.referenceDate ? new Date(dto.referenceDate) : new Date();

    const checklist = await this.db().onboardingChecklist.create({
      data: {
        employeeId: dto.employeeId,
        kind: dto.kind,
        status: 'IN_PROGRESS',
        referenceDate,
        createdById: viewer.userId,
        tasks: {
          create: templates.map((t: any) => ({
            title: t.title,
            description: t.description ?? null,
            ownerRole: t.ownerRole ?? 'HR',
            dueDate: new Date(referenceDate.getTime() + (t.dueDayOffset ?? 0) * 86400_000),
            status: 'PENDING',
          })),
        },
      },
      include: { tasks: true },
    });

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'ONBOARDING_CHECKLIST',
      entityId: checklist.id,
      afterState: { employeeId: dto.employeeId, kind: dto.kind, taskCount: checklist.tasks.length },
    });

    // Notify the employee their checklist is ready.
    try {
      const emp = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { userId: true },
      });
      if (emp?.userId) {
        await this.notifications.createNotification(
          emp.userId,
          dto.kind === 'ONBOARDING' ? 'Welcome! Your onboarding checklist' : 'Your offboarding checklist',
          `You have ${checklist.tasks.length} tasks to complete.`,
          `/onboarding/${checklist.id}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`Checklist notification failed (fail-open): ${e.message}`);
    }

    return checklist;
  }

  /** Scoped list: HR all; managers their team; employees their own. */
  async listChecklists(viewer: OnboardingViewer, employeeId?: string) {
    await this.requireTables();
    const where: any = {};
    if (isHrOrAdmin(viewer.roles)) {
      if (employeeId) where.employeeId = employeeId;
    } else if (!viewer.employeeId) {
      throw new ForbiddenException('User is not associated with an employee profile');
    } else if (viewer.roles.includes(SystemRole.MANAGER)) {
      const reports = await this.prisma.employee.findMany({
        where: { managerId: viewer.employeeId, deletedAt: null },
        select: { id: true },
      });
      const ids = [viewer.employeeId, ...reports.map((r) => r.id)];
      if (employeeId && !ids.includes(employeeId)) {
        throw new ForbiddenException('You do not have access to these checklists');
      }
      where.employeeId = employeeId ?? { in: ids };
    } else {
      where.employeeId = viewer.employeeId;
    }

    return this.db().onboardingChecklist.findMany({
      where,
      include: { tasks: { orderBy: { dueDate: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getChecklist(id: string, viewer: OnboardingViewer) {
    await this.requireTables();
    const checklist = await this.db().onboardingChecklist.findUnique({
      where: { id },
      include: { tasks: { orderBy: { dueDate: 'asc' } } },
    });
    if (!checklist) throw new NotFoundException('Checklist not found');

    if (!isHrOrAdmin(viewer.roles)) {
      if (!viewer.employeeId) throw new ForbiddenException('Employee profile required');
      const isOwner = checklist.employeeId === viewer.employeeId;
      const isManagerOfOwner =
        viewer.roles.includes(SystemRole.MANAGER) &&
        (await this.prisma.employee.findFirst({
          where: { id: checklist.employeeId, managerId: viewer.employeeId },
          select: { id: true },
        }));
      if (!isOwner && !isManagerOfOwner) {
        throw new ForbiddenException('You do not have access to this checklist');
      }
    }
    return checklist;
  }

  /** Assign a task owner (USER id). HR/admin or the task's role owner. */
  async assignTask(taskId: string, dto: AssignTaskDto, viewer: OnboardingViewer) {
    await this.requireTables();
    const task = await this.db().onboardingTask.findUnique({
      where: { id: taskId },
      include: { checklist: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!isHrOrAdmin(viewer.roles)) {
      throw new ForbiddenException('Only HR/admin can reassign tasks');
    }

    const updated = await this.db().onboardingTask.update({
      where: { id: taskId },
      data: { ownerUserId: dto.ownerUserId },
    });

    try {
      await this.notifications.createNotification(
        dto.ownerUserId,
        'Onboarding task assigned',
        `You were assigned: "${task.title}".`,
        `/onboarding/${task.checklistId}`,
      );
    } catch (e: any) {
      this.logger.warn(`Task-assignment notification failed (fail-open): ${e.message}`);
    }

    return updated;
  }

  /**
   * Complete a task. The employee, the assigned owner, or HR may complete it.
   * Completing every task flips the checklist to COMPLETED.
   */
  async completeTask(taskId: string, dto: CompleteTaskDto, viewer: OnboardingViewer) {
    await this.requireTables();
    const task = await this.db().onboardingTask.findUnique({
      where: { id: taskId },
      include: { checklist: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (task.status === 'DONE') return task;

    const checklist = task.checklist;
    const isOwner = checklist.employeeId === viewer.employeeId;
    const isAssignee = task.ownerUserId === viewer.userId;
    if (!isOwner && !isAssignee && !isHrOrAdmin(viewer.roles)) {
      throw new ForbiddenException('You cannot complete this task');
    }

    const updated = await this.db().onboardingTask.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        completedAt: new Date(),
        completedById: viewer.userId,
        note: dto.note ?? null,
        documentId: dto.documentId ?? null,
      },
    });

    // Roll up: all tasks done → checklist COMPLETED.
    const remaining = await this.db().onboardingTask.count({
      where: { checklistId: task.checklistId, status: { not: 'DONE' } },
    });
    let checklistStatus = checklist.status;
    if (remaining === 0 && checklist.status !== 'COMPLETED') {
      await this.db().onboardingChecklist.update({
        where: { id: task.checklistId },
        data: { status: 'COMPLETED' },
      });
      checklistStatus = 'COMPLETED';
    }

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.UPDATE,
      entityType: 'ONBOARDING_TASK',
      entityId: taskId,
      beforeState: { status: task.status },
      afterState: { status: 'DONE', checklistStatus, documentId: dto.documentId ?? null },
    });

    return { ...updated, checklistStatus };
  }
}
