import * as nodemailer from 'nodemailer';
import { EmailMessage, EmailProvider } from './types.js';

/**
 * SMTP configuration for the shared nodemailer provider.
 *
 * Env contract (shared by the API and the worker so the extraction stays
 * mechanical): SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true' =
 * implicit TLS, e.g. port 465), SMTP_USER, SMTP_PASS, EMAIL_FROM.
 */
export interface SmtpProviderConfig {
  host: string;
  port?: number;
  /** Implicit TLS on connect (port 465 style). Otherwise STARTTLS when advertised. */
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export const DEFAULT_SMTP_PORT = 587;
export const DEFAULT_SMTP_FROM = 'no-reply@ems.local';

/**
 * The single nodemailer-based SMTP EmailProvider for the platform.
 *
 * Framework-free: constructed from a plain config object so both the NestJS
 * API (via a thin @Injectable adapter) and the plain-TS worker can share
 * this exact implementation.
 *
 * Fail-closed: `send()` throws on transport failure so the caller's retry
 * machinery (BullMQ) can act on it. Construction throws when no host is
 * configured — use `LogEmailProvider` explicitly for the dev fallback
 * instead of a silently-disabled SMTP provider.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(config: SmtpProviderConfig) {
    const host = (config.host || '').trim();
    if (!host) {
      throw new Error(
        '[mailer] SmtpEmailProvider selected but SMTP_HOST is not configured. ' +
          'Set SMTP_HOST or use LogEmailProvider for the dev fallback.',
      );
    }
    const port = config.port ?? DEFAULT_SMTP_PORT;
    const secure = config.secure ?? false;
    this.from = (config.from || '').trim() || DEFAULT_SMTP_FROM;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(config.user && config.pass ? { auth: { user: config.user, pass: config.pass } } : {}),
      // Sensible timeouts: callers must not hang forever on a dead relay.
      connectionTimeout: config.connectionTimeoutMs ?? 10_000,
      greetingTimeout: config.greetingTimeoutMs ?? 10_000,
      socketTimeout: config.socketTimeoutMs ?? 15_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    // Throws on transport failure — fail-closed by contract (see types.ts).
    await this.transporter.sendMail({
      from: message.from ?? this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
    });
  }

  /** Release pooled connections. Best-effort; safe to call more than once. */
  async close(): Promise<void> {
    try {
      this.transporter.close();
    } catch {
      // ignore — shutdown path
    }
  }
}
