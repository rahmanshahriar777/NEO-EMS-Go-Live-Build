/**
 * B2 — transactional email template contract (API side of the worker's
 * rendering contract).
 *
 * Rendering happens in the WORKER (`apps/worker/src/email/templates.ts`),
 * which owns the subject/text/html for each template name. The API's job is
 * to enqueue a notification job (channel 'email') whose `data` carries the
 * fields the template documents:
 *
 *   invitation:     { actionUrl (invite link), role?, expiresNote?, name? }
 *   verification:   { actionUrl (verification link), expiresNote?, name? }
 *   password-reset: { actionUrl (reset link), expiresNote?, name? }
 *   payslip-ready:  { name?, period, netPay?, currency?, actionUrl? }
 *
 * The worker resolves the recipient as `data.email` (explicit override —
 * used for invitations to not-yet-users) falling back to the job's userId
 * row. This module is the typed source of truth for that cross-service
 * contract; the interfaces below mirror the worker's documented fields.
 */

export type EmailTemplateName =
  | 'invitation'
  | 'verification'
  | 'password-reset'
  | 'payslip-ready';

export interface InvitationEmailData {
  /** Fully-qualified accept-invitation URL (built by the API from FRONTEND_URL). */
  actionUrl: string;
  role: string;
  /** Human expiry note, e.g. '72 hours'. Rendered by the worker template. */
  expiresNote?: string;
  name?: string;
}

export interface VerificationEmailData {
  actionUrl: string;
  expiresNote?: string;
  name?: string;
}

export interface PasswordResetEmailData {
  actionUrl: string;
  expiresNote?: string;
  name?: string;
}

export interface PayslipReadyEmailData {
  name?: string;
  /** e.g. 'October 2026'. */
  period: string;
  netPay?: string;
  currency?: string;
  actionUrl?: string;
}

export type EmailTemplateData =
  | InvitationEmailData
  | VerificationEmailData
  | PasswordResetEmailData
  | PayslipReadyEmailData;

/** Short titles stored on the in-app notification record (worker side). */
export const EMAIL_TITLES: Record<EmailTemplateName, string> = {
  invitation: 'You are invited to join NEO EMS',
  verification: 'Verify your NEO EMS email address',
  'password-reset': 'Reset your NEO EMS password',
  'payslip-ready': 'Your payslip is ready',
};
