/**
 * Counsel sign-off gate for retention purges — ONE gate, ONE semantic,
 * shared by every purge path:
 *
 * - the API's GDPR multi-entity purge (`purgeExpiredRetention` in
 *   apps/api/src/modules/gdpr/gdpr.service.ts), and
 * - the worker's scheduled AI-log purge (`purgeExpiredAiLogs` in
 *   apps/worker/src/processors/maintenance.processor.ts).
 *
 * Semantics (identical in both): DRY-RUN BY DEFAULT. A real delete happens
 * only when BOTH hold:
 *   1. counsel sign-off is recorded (`GDPR_RETENTION_SIGNED_OFF=true`), AND
 *   2. the caller explicitly opts out of dry-run (`dryRun: false`).
 * An explicit `dryRun: false` without sign-off is forced back to dry-run
 * and logged loudly — deleting on placeholder retention windows is exactly
 * the risk this gate exists for.
 *
 * Setting the flag is the recorded sign-off: it must only be set after
 * counsel has reviewed the retention schedule and the review is minuted.
 */

/** Env flag recording counsel sign-off of the retention schedule. Default: unset. */
export const RETENTION_SIGNOFF_ENV = 'GDPR_RETENTION_SIGNED_OFF';

/** True only when the sign-off flag is explicitly 'true' (case-insensitive). */
export function isRetentionSignedOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[RETENTION_SIGNOFF_ENV] || '').toLowerCase() === 'true';
}
