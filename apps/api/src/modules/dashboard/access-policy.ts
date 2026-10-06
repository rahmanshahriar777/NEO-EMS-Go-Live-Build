import {
  AccessPolicyService,
  AccessPolicyViewer,
  AccessPolicyAction,
} from '../../core/access-policy/access-policy.service';

/**
 * Access-policy contract (Phase 2 item 1).
 *
 * Merged into `apps/api/src/core/access-policy/access-policy.service.ts`.
 * Re-exported here for compatibility with existing imports and token injection.
 */
export const ACCESS_POLICY = 'ACCESS_POLICY';

/** The authenticated caller, projected from the JWT payload. */
export type AccessViewer = AccessPolicyViewer;

export type AccessAction =
  | 'dashboard:company' // company-wide KPIs (headcount, payroll cost, …)
  | 'dashboard:team' // team-scoped KPIs for a manager
  | 'dashboard:self'; // own KPIs only

export interface IAccessPolicy {
  can(viewer: AccessViewer, targetEmployeeId: string | null, action: AccessAction): Promise<boolean> | boolean;
}

/**
 * Merged implementation delegating to the unified AccessPolicyService.
 */
/**
 * Fail-closed local fallback implementing the documented interface.
 * Merged logic is canonical in core/access-policy/AccessPolicyService.
 */
export class LocalAccessPolicyService implements IAccessPolicy {
  can(viewer: AccessViewer, _targetEmployeeId: string | null, action: AccessAction): boolean {
    const roles = viewer.roles ?? [];
    const isHr = roles.includes('SUPER_ADMIN') || roles.includes('HR_ADMIN') || roles.includes('AUDITOR');
    if (action === 'dashboard:company') return isHr;
    if (action === 'dashboard:team') {
      return isHr || (roles.includes('MANAGER') && !!viewer.employeeId);
    }
    return !!viewer.employeeId || isHr;
  }
}
