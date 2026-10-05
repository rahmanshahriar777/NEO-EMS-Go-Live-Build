/**
 * Per-entity retention schedule (Phase 2 item 3, go-live hardening).
 *
 * !!! COUNSEL SIGN-OFF PENDING — READ BEFORE CHANGING !!!
 *
 * Every `retentionDays` value below is a PLACEHOLDER, not a legal
 * determination. The numbers encode the team's best current understanding
 * (UK GDPR storage-limitation + HMRC statutory minimums for payroll-adjacent
 * records), but they MUST be reviewed and signed off by counsel before the
 * purge job is allowed to delete anything.
 *
 * Enforcement: `purgeExpiredRetention()` in gdpr.service.ts FORCES dry-run
 * (count + log only, no deletes) until `GDPR_RETENTION_SIGNED_OFF=true` is
 * set in the environment. Setting that flag is the recorded sign-off — it
 * must only be set after counsel has reviewed THIS schedule and the review
 * is minuted. The flag, the schedule version, and every purge run are
 * written to the audit log.
 *
 * Design rules for this schedule:
 * - Statutory / financial-history entities are NEVER purgeable by this job
 *   (`purgeable: false`): payroll runs/payslips, attendance, leave requests,
 *   audit logs (which have their own retention purge with a truncation
 *   checkpoint), documents, erasure requests (legal evidence).
 * - Only low-risk operational rows (expired tokens, old AI logs, old
 *   in-app notifications, old login-audit rows) are purgeable, and only
 *   after sign-off.
 * - Erasure-request approval stays a human HR decision; this schedule does
 *   not auto-gate erasure.
 */

export interface RetentionRule {
  /** Prisma model name (human-readable entity). */
  entity: string;
  /** Prisma delegate key on PrismaService, e.g. 'aIRequestLog'. */
  model: string;
  /** Date field the retention window is measured against. */
  dateField: string;
  /**
   * PLACEHOLDER retention window in days — counsel sign-off pending.
   * Rows older than `now - retentionDays` (on `dateField`) are purge
   * candidates when `purgeable` is true.
   */
  retentionDays: number;
  /** Placeholder rationale — replace with counsel's determination. */
  basis: string;
  /** Whether the purge job may delete rows under this rule (post sign-off). */
  purgeable: boolean;
}

/**
 * Counsel sign-off gate — the single shared implementation lives in
 * `@ems/shared` (`packages/shared/src/retention.ts`) so the API's GDPR
 * multi-entity purge and the worker's AI-log purge enforce IDENTICAL
 * semantics. Re-exported here so existing importers keep working.
 */
export { RETENTION_SIGNOFF_ENV, isRetentionSignedOff } from '@ems/shared';

export const RETENTION_SCHEDULE_VERSION = '2026-10-05/v1';

export const RETENTION_SCHEDULE: RetentionRule[] = [
  // ------------------------------------------------------------------
  // Purgeable after sign-off (low-risk operational data)
  // ------------------------------------------------------------------
  {
    entity: 'AIRequestLog',
    model: 'aIRequestLog',
    dateField: 'createdAt',
    retentionDays: 90,
    basis:
      'PLACEHOLDER: matches the existing AI log purge default (90d). ' +
      'AI prompts may contain PII — counsel to confirm the window.',
    purgeable: true,
  },
  {
    entity: 'Notification (in-app)',
    model: 'notification',
    dateField: 'createdAt',
    retentionDays: 365,
    basis:
      'PLACEHOLDER: 1 year keeps the notification centre useful while ' +
      'bounding PII in message bodies. Counsel to confirm.',
    purgeable: true,
  },
  {
    entity: 'LoginAuditLog',
    model: 'loginAuditLog',
    dateField: 'createdAt',
    retentionDays: 365,
    basis:
      'PLACEHOLDER: 1 year of login telemetry for incident response. ' +
      'Contains attempted email addresses (PII). Counsel to confirm.',
    purgeable: true,
  },
  {
    entity: 'RefreshToken (expired)',
    model: 'refreshToken',
    dateField: 'expiresAt',
    retentionDays: 30,
    basis:
      'PLACEHOLDER: 30 days past expiry keeps reuse-detection forensics; ' +
      'only token hashes are stored. Counsel to confirm.',
    purgeable: true,
  },
  {
    entity: 'PasswordResetToken (expired)',
    model: 'passwordResetToken',
    dateField: 'expiresAt',
    retentionDays: 30,
    basis:
      'PLACEHOLDER: 30 days past expiry for abuse forensics. Counsel to confirm.',
    purgeable: true,
  },
  // ------------------------------------------------------------------
  // NEVER purged by this job (statutory history / legal evidence / own
  // retention mechanism). Listed so the schedule is explicit about them.
  // ------------------------------------------------------------------
  {
    entity: 'AuditLog',
    model: 'auditLog',
    dateField: 'createdAt',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: 7 years, the UK statutory ceiling for payroll-adjacent ' +
      'records (HMRC). Purged only by AuditService.purgeExpiredAuditLogs, ' +
      'which writes a truncation checkpoint so the hash chain stays ' +
      'verifiable. Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'PayrollRun / Payslip',
    model: 'payrollRun',
    dateField: 'createdAt',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: 7 years (HMRC). Financial history — never deleted by ' +
      'this job. Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'AttendanceRecord',
    model: 'attendanceRecord',
    dateField: 'date',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: 7 years (payroll-adjacent). Never deleted by this job. ' +
      'Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'LeaveRequest',
    model: 'leaveRequest',
    dateField: 'createdAt',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: 7 years (payroll-adjacent). Never deleted by this job. ' +
      'Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'Document',
    model: 'document',
    dateField: 'createdAt',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: document bytes follow the document retention policy ' +
      '(soft-delete + retention window), not this job. Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'ErasureRequest',
    model: 'erasureRequest',
    dateField: 'createdAt',
    retentionDays: 2555,
    basis:
      'PLACEHOLDER: erasure decisions are legal evidence of GDPR compliance — ' +
      'retained, never purged by this job. Counsel to confirm.',
    purgeable: false,
  },
  {
    entity: 'Invitation',
    model: 'invitation',
    dateField: 'createdAt',
    retentionDays: 365,
    basis:
      'PLACEHOLDER: invitation history supports access audits; excluded ' +
      'from auto-purge pending counsel review of the onboarding audit trail.',
    purgeable: false,
  },
];
