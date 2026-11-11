import { ForbiddenException, Injectable } from '@nestjs/common';
import { SystemRole } from '@ems/shared';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { AccessPolicyService, AccessPolicyViewer } from '../../../core/access-policy/access-policy.service';

export interface FieldReportViewer extends AccessPolicyViewer {
  email?: string;
  permissions: string[];
}

export interface ReviewAuthorizationResult {
  allowed: boolean;
  actedAsDelegateForId: string | null;
  reason?: string;
}

@Injectable()
export class FieldReportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  isHrOrAdmin(roles: string[]): boolean {
    return (
      roles.includes(SystemRole.SUPER_ADMIN) ||
      roles.includes(SystemRole.HR_ADMIN)
    );
  }

  /**
   * AUDITOR is intentionally excluded from employee-scoped operational records
   * even if misconfigured; HR_ADMIN and SUPER_ADMIN override.
   */
  isExplicitlyAuditorOnly(roles: string[]): boolean {
    if (this.isHrOrAdmin(roles)) return false;
    return (
      roles.includes(SystemRole.AUDITOR) &&
      !roles.includes(SystemRole.MANAGER) &&
      !roles.includes(SystemRole.EMPLOYEE)
    );
  }

  async findActiveDelegationForReport(
    delegateEmployeeId: string | undefined,
    reportOwnerEmployeeId: string,
    entityId: string | null,
    now: Date = new Date(),
  ): Promise<{ delegatorEmployeeId: string } | null> {
    if (!delegateEmployeeId) return null;

    const owner = await this.prisma.employee.findFirst({
      where: { id: reportOwnerEmployeeId, deletedAt: null },
      select: { managerId: true },
    });
    if (!owner?.managerId) return null;

    const delegation = await this.prisma.fieldReportDelegation.findFirst({
      where: {
        delegatorEmployeeId: owner.managerId,
        delegateEmployeeId,
        isActive: true,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
        OR: [
          { entityId: null },
          ...(entityId ? [{ entityId }] : []),
        ],
      },
      select: { delegatorEmployeeId: true },
    });

    return delegation ?? null;
  }

  /**
   * Returns delegator employee IDs whose active delegation grants `delegateEmployeeId`
   * team review visibility.
   */
  async getActiveDelegatorIds(
    delegateEmployeeId: string | undefined,
    now: Date = new Date(),
  ): Promise<Array<{ delegatorEmployeeId: string; entityId: string | null }>> {
    if (!delegateEmployeeId) return [];
    return this.prisma.fieldReportDelegation.findMany({
      where: {
        delegateEmployeeId,
        isActive: true,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      select: { delegatorEmployeeId: true, entityId: true },
    });
  }

  async canRead(
    viewer: FieldReportViewer,
    report: { employeeId: string; entityId: string | null },
  ): Promise<{ allowed: boolean; actedAsDelegateForId: string | null }> {
    if (this.isExplicitlyAuditorOnly(viewer.roles)) {
      return { allowed: false, actedAsDelegateForId: null };
    }

    const directOk = await this.accessPolicy.can(
      { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
      report.employeeId,
      'view',
    );
    if (directOk) {
      return { allowed: true, actedAsDelegateForId: null };
    }

    const delegation = await this.findActiveDelegationForReport(
      viewer.employeeId,
      report.employeeId,
      report.entityId,
    );
    if (delegation) {
      return { allowed: true, actedAsDelegateForId: delegation.delegatorEmployeeId };
    }

    return { allowed: false, actedAsDelegateForId: null };
  }

  async assertCanRead(
    viewer: FieldReportViewer,
    report: { employeeId: string; entityId: string | null },
  ): Promise<{ actedAsDelegateForId: string | null }> {
    const res = await this.canRead(viewer, report);
    if (!res.allowed) {
      throw new ForbiddenException({
        message: 'You do not have access to this field report.',
        error: 'FORBIDDEN',
      });
    }
    return { actedAsDelegateForId: res.actedAsDelegateForId };
  }

  async canReview(
    viewer: FieldReportViewer,
    report: { employeeId: string; entityId: string | null },
  ): Promise<ReviewAuthorizationResult> {
    if (this.isExplicitlyAuditorOnly(viewer.roles)) {
      return { allowed: false, actedAsDelegateForId: null, reason: 'AUDITOR_EXCLUDED' };
    }

    if (viewer.employeeId && viewer.employeeId === report.employeeId) {
      return { allowed: false, actedAsDelegateForId: null, reason: 'SELF_REVIEW_FORBIDDEN' };
    }

    if (this.isHrOrAdmin(viewer.roles)) {
      return { allowed: true, actedAsDelegateForId: null };
    }

    if (viewer.roles.includes(SystemRole.MANAGER)) {
      const managerOk = await this.accessPolicy.can(
        { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
        report.employeeId,
        'approve',
      );
      if (managerOk) {
        return { allowed: true, actedAsDelegateForId: null };
      }
    }

    const delegation = await this.findActiveDelegationForReport(
      viewer.employeeId,
      report.employeeId,
      report.entityId,
    );
    if (delegation) {
      return { allowed: true, actedAsDelegateForId: delegation.delegatorEmployeeId };
    }

    return { allowed: false, actedAsDelegateForId: null, reason: 'NOT_AUTHORIZED_REVIEWER' };
  }

  async assertCanReview(
    viewer: FieldReportViewer,
    report: { employeeId: string; entityId: string | null },
  ): Promise<{ actedAsDelegateForId: string | null }> {
    const res = await this.canReview(viewer, report);
    if (!res.allowed) {
      const msg =
        res.reason === 'SELF_REVIEW_FORBIDDEN'
          ? 'You cannot approve or review your own field report.'
          : 'You are not authorized to review this field report.';
      throw new ForbiddenException({ message: msg, error: 'FORBIDDEN' });
    }
    return { actedAsDelegateForId: res.actedAsDelegateForId };
  }
}

