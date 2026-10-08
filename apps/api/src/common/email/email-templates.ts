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
  /** Fully-qualified invitation-accept URL (built by the API from FRONTEND_URL). */
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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f6f3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1816; line-height: 1.6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f7f6f3; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2dfda; overflow: hidden; box-shadow: 0 2px 8px rgba(26,24,22,0.06);">
          <tr>
            <td style="padding: 28px 32px 20px; border-bottom: 3px solid #2c5f4a;">
              <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #2c5f4a; display: block; margin-bottom: 6px;">NEO EMPLOYEE MANAGEMENT SYSTEM</span>
              <h1 style="margin: 0; font-size: 22px; font-weight: 600; color: #1a1816;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 32px; font-size: 14px; color: #374151; line-height: 1.65;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 32px; background-color: #faf9f7; border-top: 1px solid #ece9e4; font-size: 12px; color: #6b6560;">
              <p style="margin: 0;">This is an automated transmission from <strong>NEO EMS</strong>. Please do not reply directly to this email.</p>
              <p style="margin: 4px 0 0; color: #9b9590;">Security notice: Never forward or share single-use account setup links.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderEmailTemplate(
  template: EmailTemplateName,
  data: Record<string, any>,
): { subject: string; text: string; html: string } {
  switch (template) {
    case 'invitation': {
      const subject = 'You are invited to join NEO EMS';
      const roleText = data.role ? ` as ${data.role}` : '';
      const text =
        `Hi ${data.name || 'there'},\n\n` +
        `You have been invited to join NEO EMS${roleText}.\n` +
        `Use the one-time link below to activate your account and choose your password:\n\n` +
        `${data.actionUrl}\n\n` +
        (data.expiresNote ? `This invitation link expires in: ${data.expiresNote}\n\n` : '') +
        `If you were not expecting this invitation, please contact your HR department.\n`;

      const htmlBody = `
        <p>Hello${data.name ? ` <strong>${escapeHtml(data.name)}</strong>` : ''},</p>
        <p>You have been formally invited to join the <strong>NEO Employee Management System</strong>${roleText ? ` in the role of <strong>${escapeHtml(data.role)}</strong>` : ''}.</p>
        <p>Please click the button below to accept your invitation, verify your credentials, and choose your account password:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${escapeHtml(data.actionUrl)}" style="display: inline-block; background-color: #2c5f4a; color: #ffffff; font-weight: 600; font-size: 14px; padding: 13px 32px; border-radius: 8px; text-decoration: none; box-shadow: 0 2px 4px rgba(44,95,74,0.2);">Accept Invitation &amp; Set Password &rarr;</a>
        </div>
        <p style="font-size: 13px; color: #6b7280;">If the button does not open, copy and paste this link into your browser:</p>
        <p style="font-size: 12px; font-family: monospace; background: #f3f4f6; padding: 10px; border-radius: 6px; word-break: break-all;">${escapeHtml(data.actionUrl)}</p>
        ${data.expiresNote ? `<p style="font-size: 13px; color: #b8860b; margin-top: 20px;"><strong>Notice:</strong> This one-time security link expires in <strong>${escapeHtml(data.expiresNote)}</strong>.</p>` : ''}
      `;

      return {
        subject,
        text,
        html: wrapHtml(subject, htmlBody),
      };
    }

    case 'verification': {
      const subject = 'Verify your NEO EMS email address';
      const text =
        `Hi ${data.name || 'there'},\n\n` +
        `Please verify your email address to activate your NEO EMS account:\n\n` +
        `${data.actionUrl}\n`;
      const htmlBody = `
        <p>Please click the button below to verify your email address and activate your account:</p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${escapeHtml(data.actionUrl)}" style="display: inline-block; background-color: #2c5f4a; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px; text-decoration: none;">Verify Email Address</a>
        </div>
      `;
      return { subject, text, html: wrapHtml(subject, htmlBody) };
    }

    case 'password-reset': {
      const subject = 'Reset your NEO EMS password';
      const text =
        `Hi ${data.name || 'there'},\n\n` +
        `We received a request to reset your NEO EMS password. Use the link below to set a new one:\n\n` +
        `${data.actionUrl}\n\n` +
        `If you did not request this, you can safely ignore this email.\n`;
      const htmlBody = `
        <p>We received a request to reset your NEO EMS password. Use the button below to choose a new password:</p>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${escapeHtml(data.actionUrl)}" style="display: inline-block; background-color: #2c5f4a; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px; text-decoration: none;">Reset Password</a>
        </div>
        <p style="font-size: 12px; color: #6b7280;">If you did not request a password reset, you can safely disregard this email.</p>
      `;
      return { subject, text, html: wrapHtml(subject, htmlBody) };
    }

    case 'payslip-ready': {
      const subject = `Your payslip for ${data.period || 'the latest payroll period'} is ready`;
      const text =
        `Hi ${data.name || 'there'},\n\n` +
        `Your payslip for ${data.period || 'the latest payroll period'} has been finalized and is ready to view.\n` +
        (data.actionUrl ? `View your payslip: ${data.actionUrl}\n` : '');
      const htmlBody = `
        <p>Your payslip for <strong>${escapeHtml(data.period || 'the latest period')}</strong> is now available for review.</p>
        ${data.actionUrl ? `<div style="text-align: center; margin: 24px 0;"><a href="${escapeHtml(data.actionUrl)}" style="display: inline-block; background-color: #2c5f4a; color: #ffffff; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px; text-decoration: none;">View Payslip</a></div>` : ''}
      `;
      return { subject, text, html: wrapHtml(subject, htmlBody) };
    }

    default: {
      const subject = String(data.title || 'NEO EMS Notification');
      const text = String(data.message || '');
      const htmlBody = `<p>${escapeHtml(text)}</p>`;
      return { subject, text, html: wrapHtml(subject, htmlBody) };
    }
  }
}

