/**
 * Transactional email templates for the worker's email channel (Phase 1 B2).
 *
 * The notification job carries `{ template, data }`; the API producer fills
 * `data` with the fields each template documents below. Unknown template
 * names fall back to a generic title/message render rather than failing —
 * the in-app record is always the source of truth.
 *
 * Assumption: `data.actionUrl` is a fully-qualified https URL built by the
 * API (the worker must not guess the web origin). `data.name` is the
 * recipient's display name when known.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type TemplateData = Record<string, any>;

function line(label: string, value: unknown): string {
  return value ? `${label}: ${value}\n` : '';
}

function wrapHtml(title: string, bodyHtml: string): string {
  return (
    `<html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">` +
    `<h2>${escapeHtml(title)}</h2>${bodyHtml}` +
    `<hr/><p style="color:#666;font-size:12px;">NEO EMS — do not reply to this automated message.</p>` +
    `</body></html>`
  );
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function actionBlock(data: TemplateData): { text: string; html: string } {
  const text = data.actionUrl ? `\n${data.actionUrl}\n` : '';
  const html = data.actionUrl
    ? `<p><a href="${escapeHtml(data.actionUrl)}" style="display:inline-block;padding:10px 20px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;">${escapeHtml(data.actionLabel || 'Open NEO EMS')}</a></p>`
    : '';
  return { text, html };
}

const TEMPLATES: Record<string, (data: TemplateData) => RenderedEmail> = {
  // data: { name?, actionUrl (invite link), role?, expiresNote? }
  invitation: (data) => {
    const subject = 'You are invited to join NEO EMS';
    const text =
      `Hi ${data.name || 'there'},\n\n` +
      `You have been invited to join NEO EMS${data.role ? ` as ${data.role}` : ''}.\n` +
      `Use the link below to create your account and set your password.\n` +
      line('This link expires', data.expiresNote) +
      actionBlock(data).text;
    return {
      subject,
      text,
      html: wrapHtml(subject, `<p>Hi ${escapeHtml(data.name || 'there')},</p><p>You have been invited to join NEO EMS${data.role ? ` as <strong>${escapeHtml(data.role)}</strong>` : ''}. Use the link below to create your account and set your password.</p>${data.expiresNote ? `<p>This link expires: ${escapeHtml(data.expiresNote)}</p>` : ''}${actionBlock(data).html}`),
    };
  },

  // data: { name?, actionUrl (verification link) }
  verification: (data) => {
    const subject = 'Verify your NEO EMS email address';
    const text =
      `Hi ${data.name || 'there'},\n\n` +
      `Please verify your email address to activate your NEO EMS account.\n` +
      actionBlock(data).text;
    return {
      subject,
      text,
      html: wrapHtml(subject, `<p>Hi ${escapeHtml(data.name || 'there')},</p><p>Please verify your email address to activate your NEO EMS account.</p>${actionBlock(data).html}`),
    };
  },

  // data: { name?, actionUrl (reset link), expiresNote? }
  'password-reset': (data) => {
    const subject = 'Reset your NEO EMS password';
    const text =
      `Hi ${data.name || 'there'},\n\n` +
      `We received a request to reset your NEO EMS password. Use the link below to choose a new one.\n` +
      `If you did not request this, you can safely ignore this email.\n` +
      line('This link expires', data.expiresNote) +
      actionBlock(data).text;
    return {
      subject,
      text,
      html: wrapHtml(subject, `<p>Hi ${escapeHtml(data.name || 'there')},</p><p>We received a request to reset your NEO EMS password. Use the link below to choose a new one.</p><p>If you did not request this, you can safely ignore this email.</p>${data.expiresNote ? `<p>This link expires: ${escapeHtml(data.expiresNote)}</p>` : ''}${actionBlock(data).html}`),
    };
  },

  // data: { name?, period (e.g. "October 2026"), netPay?, currency?, actionUrl? }
  'payslip-ready': (data) => {
    const subject = `Your payslip for ${data.period || 'the latest payroll run'} is ready`;
    const text =
      `Hi ${data.name || 'there'},\n\n` +
      `Your payslip${data.period ? ` for ${data.period}` : ''} is ready in NEO EMS.\n` +
      line('Net pay', data.netPay ? `${data.currency || ''} ${data.netPay}`.trim() : undefined) +
      actionBlock(data).text;
    return {
      subject,
      text,
      html: wrapHtml(subject, `<p>Hi ${escapeHtml(data.name || 'there')},</p><p>Your payslip${data.period ? ` for <strong>${escapeHtml(data.period)}</strong>` : ''} is ready in NEO EMS.</p>${data.netPay ? `<p>Net pay: <strong>${escapeHtml(`${data.currency || ''} ${data.netPay}`.trim())}</strong></p>` : ''}${actionBlock(data).html}`),
    };
  },
};

/** Render a template; unknown names fall back to a generic title/message email. */
export function renderTemplate(template: string, data: TemplateData = {}): RenderedEmail {
  const render = TEMPLATES[template];
  if (render) return render(data);
  const subject = String(data.subject || data.title || 'NEO EMS notification');
  const text = String(data.text || data.message || '');
  return {
    subject,
    text,
    html: wrapHtml(subject, text ? `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>` : ''),
  };
}

/** Template names the worker knows how to render richly. */
export const KNOWN_TEMPLATES = Object.keys(TEMPLATES);
