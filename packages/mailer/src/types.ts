/**
 * Shared email contracts (framework-free).
 *
 * Single-implementation rule (go-live hardening): this package owns the ONE
 * nodemailer-based SMTP provider (`smtp-provider.ts`). The API adapts it to
 * NestJS (`apps/api/src/common/email/`) and the worker uses it directly
 * (`apps/worker/src/email/smtp-sender.ts`) — no second SMTP client anywhere.
 *
 * Sending policy (unchanged from the API's B2 design): the API never sends
 * email inline (SMTP latency does not belong in request handlers). Providers
 * are invoked by the WORKER's notification processor via the `notifications`
 * queue (channel 'email').
 */

/** A fully-rendered outbound email. */
export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body (deliverability fallback). */
  text?: string;
  /** HTML body. */
  html?: string;
  /** Optional From override; defaults to the provider's configured sender. */
  from?: string;
  /** Optional Reply-To header. */
  replyTo?: string;
}

/**
 * EmailProvider contract.
 *
 * Implementations MUST throw on delivery failure (fail-closed): a lost email
 * must be visible to the caller (so BullMQ can retry), never silently
 * dropped. Returning normally means "accepted for delivery".
 */
export interface EmailProvider {
  /** Human-readable provider name for logs, e.g. 'smtp' | 'log'. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
