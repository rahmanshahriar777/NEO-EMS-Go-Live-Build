import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemRole } from '@ems/shared';

/**
 * Central object-level access policy (BUILD_SPEC A1–A6).
 *
 * Rule: a viewer may act on a target employee record when the viewer is
 * - the employee themselves (`viewer.employeeId === targetEmployeeId`), or
 * - the target's direct manager (`target.managerId === viewer.employeeId`,
 *   requires the MANAGER role — "own team"), or
 * - HR / SUPER_ADMIN (unrestricted).
 *
 * Everyone else is denied. The check is deliberately narrow: peers,
 * subordinates-of-peers, auditors and unauthenticated callers get `false`.
 * AUDITOR is intentionally NOT granted here — auditors read via dedicated
 * audit/report endpoints, not employee-scoped ones.
 */
export interface AccessPolicyViewer {
  userId: string;
  roles: string[];
  employeeId?: string;
}

export type AccessPolicyAction = 'view' | 'edit' | 'approve' | 'review';

@Injectable()
export class AccessPolicyService {
  private readonly logger = new Logger(AccessPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  private isHrOrAdmin(roles: string[]): boolean {
    return (
      roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN)
    );
  }

  /**
   * Returns true when `viewer` may perform `action` on the employee record
   * `targetEmployeeId`. All four actions share the same rule set for now;
   * the `action` parameter is kept so callers express intent and future
   * policy can diverge per action without touching call sites.
   */
  async can(
    viewer: AccessPolicyViewer,
    targetEmployeeId: string,
    _action: AccessPolicyAction,
  ): Promise<boolean> {
    if (!targetEmployeeId) return false;

    // HR / SUPER_ADMIN: unrestricted.
    if (this.isHrOrAdmin(viewer.roles)) return true;

    if (!viewer.employeeId) {
      // No linked employee profile and not HR: nothing is visible.
      // (A6: callers with no linked employee get empty results upstream;
      // this is the hard deny behind it.)
      return false;
    }

    // Self.
    if (viewer.employeeId === targetEmployeeId) return true;

    // Own team: the target's direct manager is the viewer. Only viewers
    // carrying the MANAGER role count as managers — an employeeId match
    // alone is not enough.
    if (viewer.roles.includes(SystemRole.MANAGER)) {
      const target = await this.prisma.employee.findFirst({
        where: { id: targetEmployeeId, deletedAt: null },
        select: { managerId: true },
      });
      if (target?.managerId === viewer.employeeId) return true;
    }

    return false;
  }

  /**
   * Batch variant: returns the subset of `targetEmployeeIds` the viewer may
   * act on. Avoids N+1 manager lookups by fetching targets in one query.
   */
  async filterAllowed(
    viewer: AccessPolicyViewer,
    targetEmployeeIds: string[],
    action: AccessPolicyAction,
  ): Promise<string[]> {
    if (targetEmployeeIds.length === 0) return [];
    if (this.isHrOrAdmin(viewer.roles)) return [...targetEmployeeIds];
    if (!viewer.employeeId) return [];

    const allowed = new Set<string>();
    for (const id of targetEmployeeIds) {
      if (id === viewer.employeeId) allowed.add(id);
    }
    const rest = targetEmployeeIds.filter((id) => !allowed.has(id));
    if (rest.length > 0 && viewer.roles.includes(SystemRole.MANAGER)) {
      const targets = await this.prisma.employee.findMany({
        where: { id: { in: rest }, deletedAt: null },
        select: { id: true, managerId: true },
      });
      for (const t of targets) {
        if (t.managerId === viewer.employeeId) allowed.add(t.id);
      }
    }
    return targetEmployeeIds.filter((id) => allowed.has(id));
  }

  /** Builds an AccessPolicyViewer from the JWT payload. */
  static fromJwt(user: { sub: string; roles: string[]; employeeId?: string }): AccessPolicyViewer {
    return { userId: user.sub, roles: user.roles, employeeId: user.employeeId };
  }
}
