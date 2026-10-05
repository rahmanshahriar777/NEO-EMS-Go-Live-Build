/**
 * The 60 platform permissions, mirrored 1:1 from the database seed
 * (`packages/database/prisma/seed.ts`: 10 subjects × 6 actions).
 *
 * Permission strings in JWTs / the PermissionsGuard are formatted
 * `SUBJECT:ACTION` (see auth.service `extractPermissions`).
 *
 * The seed grants ZERO permissions to any role by default (documented in the
 * documents controller) — the role editor assigns them explicitly.
 */
export const PERMISSION_SUBJECTS = [
  'USER',
  'EMPLOYEE',
  'DEPARTMENT',
  'DESIGNATION',
  'ATTENDANCE',
  'LEAVE',
  'PAYROLL',
  'PERFORMANCE',
  'AUDIT_LOG',
  'DOCUMENT',
] as const;

export const PERMISSION_ACTIONS = [
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'MANAGE',
  'APPROVE',
] as const;

export interface PermissionDef {
  code: string; // e.g. "EMPLOYEE:READ"
  subject: string;
  action: string;
  description: string;
}

export const ALL_PERMISSIONS: PermissionDef[] = PERMISSION_SUBJECTS.flatMap((subject) =>
  PERMISSION_ACTIONS.map((action) => ({
    code: `${subject}:${action}`,
    subject,
    action,
    description: `Permission to ${action} ${subject}`,
  })),
);
