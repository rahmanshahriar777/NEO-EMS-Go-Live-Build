import {
  SmtpEmailProvider,
  type EmailProvider,
  type EmailAttachment,
} from '@ems/mailer';

/**
 * Worker-side email sender — thin adapter over the dedicated `@ems/mailer`
 * package (single shared nodemailer implementation).
 *
 * Single-implementation rule (go-live hardening): the hand-rolled net/tls
 * SMTP client that used to live in this file is deleted. SMTP delivery for
 * the whole platform is the shared `SmtpEmailProvider`; this module keeps
 * the worker's env-var contract (`resolveSmtpConfig`) and exposes the
 * provider. The env-var contract is unchanged:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true' = implicit TLS,
 *   e.g. port 465), SMTP_USER, SMTP_PASSWORD, SMTP_FROM, EMAIL_FROM
 *   (legacy alias, honoured as fallback), SMTP_TIMEOUT_MS (default 15000).
 *
 * When SMTP_HOST is unset the sender is disabled — the email processor then
 * falls back to logging the message (dev behaviour, never claimed as sent).
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS on connect (port 465 style). Otherwise STARTTLS is used when advertised. */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  timeoutMs?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** File attachments, passed through to the shared provider. */
  attachments?: EmailAttachment[];
}

/** Resolve SMTP config from the environment. Returns null when disabled (no SMTP_HOST). */
export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) return null;
  const port = parseInt(env.SMTP_PORT || '587', 10) || 587;
  const secureEnv = (env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv === 'true' || (secureEnv !== 'false' && port === 465);
  return {
    host,
    port,
    secure,
    user: env.SMTP_USER || undefined,
    pass: env.SMTP_PASSWORD || env.SMTP_PASS || undefined,
    from: (env.SMTP_FROM || env.EMAIL_FROM || 'shahriar@neotericdigitalbd.com').trim(),
    timeoutMs: parseInt(env.SMTP_TIMEOUT_MS || '15000', 10) || 15000,
  };
}

/**
 * Build the shared SMTP provider from a resolved config. Throws when the
 * config has no host (fail-closed) — callers must check resolveSmtpConfig()
 * first and take the dev-log fallback.
 */
export function createSmtpProvider(config: SmtpConfig): EmailProvider {
  return new SmtpEmailProvider({
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    pass: config.pass,
    from: config.from,
    connectionTimeoutMs: config.timeoutMs,
    greetingTimeoutMs: config.timeoutMs,
    socketTimeoutMs: config.timeoutMs,
  });
}

/**
 * Send one message via the shared provider.
 *
 * Fail-closed: throws on delivery failure so the notification processor can
 * let BullMQ retry (the in-app notification row is already persisted as the
 * guaranteed fallback).
 */
export async function sendSmtp(config: SmtpConfig, msg: EmailMessage): Promise<void> {
  if (!msg.to) {
    throw new Error('Refusing to send email without recipient.');
  }
  if (!msg.subject) {
    throw new Error('Refusing to send email without subject.');
  }
  const provider = createSmtpProvider(config);
  try {
    await provider.send({
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      from: msg.from ?? config.from,
      replyTo: msg.replyTo,
      attachments: msg.attachments,
    });
  } finally {
    await (provider as SmtpEmailProvider).close();
  }
}

/* NOTE: the hand-rolled net/tls SMTP client (buildMimeMessage, SmtpSession,
 * SmtpError, and the old sendSmtp) was deleted in the go-live hardening:
 * delivery is the shared nodemailer provider now (see createSmtpProvider /
 * sendSmtp above). The fake-relay protocol tests in smtp-sender.test.ts were
 * replaced accordingly. */
