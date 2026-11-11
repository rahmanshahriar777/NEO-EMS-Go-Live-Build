/**
 * The 67 platform permissions, mirrored 1:1 from the database seed
 * (`packages/database/prisma/seed.ts`: 10 base subjects × 6 actions + 7 FIELD_REPORT actions).
 *
 * Permission strings in JWTs / the PermissionsGuard are formatted
 * `SUBJECT:ACTION` (see auth.service `extractPermissions`).
 */
export const BASE_PERMISSION_SUBJECTS = [
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

export const PERMISSION_SUBJECTS = [
  ...BASE_PERMISSION_SUBJECTS,
  'FIELD_REPORT',
] as const;

export const PERMISSION_ACTIONS = [
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'MANAGE',
  'APPROVE',
] as const;

export const FIELD_REPORT_ACTIONS = [
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'REVIEW',
  'DOWNLOAD_ORIGINAL',
  'MANAGE',
] as const;

export interface PermissionDef {
  code: string; // e.g. "EMPLOYEE:READ"
  subject: string;
  action: string;
  description: string;
}

const FIELD_REPORT_DESCRIPTIONS: Record<(typeof FIELD_REPORT_ACTIONS)[number], string> = {
  CREATE: 'Create draft field reports and upload media',
  READ: 'View authorized field reports and previews',
  UPDATE: 'Edit draft field report metadata',
  DELETE: 'Soft-delete draft or permitted field reports',
  REVIEW: 'Review, comment, approve, reject, or request changes',
  DOWNLOAD_ORIGINAL: 'Download bit-exact full-resolution Original media',
  MANAGE: 'Manage field report policies, legal holds, and cross-team delegations',
};

export const ALL_PERMISSIONS: PermissionDef[] = [
  ...BASE_PERMISSION_SUBJECTS.flatMap((subject) =>
    PERMISSION_ACTIONS.map((action) => ({
      code: `${subject}:${action}`,
      subject,
      action,
      description: `Permission to ${action} ${subject}`,
    })),
  ),
  ...FIELD_REPORT_ACTIONS.map((action) => ({
    code: `FIELD_REPORT:${action}`,
    subject: 'FIELD_REPORT',
    action,
    description: FIELD_REPORT_DESCRIPTIONS[action],
  })),
];
