import { SystemRole } from '@ems/shared';

/**
 * Access-policy contract (Phase 2 item 1).
 *
 * Worker 2 owns `apps/api/src/core/access-policy/` and its
 * `AccessPolicyService.can(viewer, targetEmployeeId, action)`. That module is
 * NOT landed yet, so the dashboard codes against this documented interface and
 * ships a fail-closed local fallback. When the core module lands, replace the
 * `ACCESS_POLICY` provider in `dashboard.module.ts` with the real service —
 * no dashboard code changes are needed beyond the provider swap.
 */

export const ACCESS_POLICY = 'ACCESS_POLICY';

/** The authenticated caller, projected from the JWT payload. */
export interface AccessViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

export type AccessAction =
  | 'dashboard:company' // company-wide KPIs (headcount, payroll cost, …)
  | 'dashboard:team' // team-scoped KPIs for a manager
  | 'dashboard:self'; // own KPIs only

export interface IAccessPolicy {
  can(viewer: AccessViewer, targetEmployeeId: string | null, action: AccessAction): Promise<boolean> | boolean;
}

const HR_ROLES = [SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR];

/**
 * Fail-closed local fallback implementing the documented interface.
 * Rule: HR roles see company-wide; MANAGER with a linked employee profile
 * sees their team; everyone else sees only themselves. Unknown/roleless
 * callers get nothing.
 */
export class LocalAccessPolicyService implements IAccessPolicy {
  can(viewer: AccessViewer, _targetEmployeeId: string | null, action: AccessAction): boolean {
    const roles = viewer.roles ?? [];
    const isHr = roles.some((r) => (HR_ROLES as string[]).includes(r));
    if (action === 'dashboard:company') return isHr;
    if (action === 'dashboard:team') {
      return isHr || (roles.includes(SystemRole.MANAGER) && !!viewer.employeeId);
    }
    // dashboard:self — any authenticated caller with an employee profile.
    return !!viewer.employeeId || isHr;
  }
}
