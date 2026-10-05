import { SystemRole } from '@ems/shared';

/**
 * Compensation visibility (F13): only HR/admin roles may see salary data.
 * Everyone else gets the profile with compensation fields stripped.
 *
 * SENSITIVE PROFILE FIELDS (Phase 2, item 3): bankAccountEnc / taxIdEnc are
 * encrypted identifiers that only HR/admin may read — they are stripped for
 * everyone else, including the owning employee and their manager.
 */
const COMPENSATION_FIELDS = ['salaryStructures'] as const;
const HR_ONLY_PROFILE_FIELDS = ['bankAccountEnc', 'taxIdEnc'] as const;

export function canViewCompensation(roles: string[] | undefined): boolean {
  if (!roles) return false;
  return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
}

/**
 * Strips compensation fields from an employee payload for unauthorized
 * viewers. The input shape is the Prisma result (includes optional
 * `salaryStructures`); the output keeps everything else intact.
 */
export function sanitizeEmployee<T extends Record<string, any>>(
  employee: T,
  roles: string[] | undefined,
): T | Omit<T, (typeof COMPENSATION_FIELDS)[number] | (typeof HR_ONLY_PROFILE_FIELDS)[number]> {
  if (canViewCompensation(roles)) {
    return employee;
  }
  const copy: Record<string, any> = { ...employee };
  for (const field of [...COMPENSATION_FIELDS, ...HR_ONLY_PROFILE_FIELDS]) {
    delete copy[field];
  }
  return copy as Omit<T, (typeof COMPENSATION_FIELDS)[number] | (typeof HR_ONLY_PROFILE_FIELDS)[number]>;
}
