/**
 * B2 — EmailProvider contract (thin re-export shim).
 *
 * The canonical contracts now live in the dedicated `@ems/mailer` package
 * (single email implementation; server-only — never in the @ems/shared
 * browser barrel). This file keeps the existing import paths working:
 * `EMAIL_PROVIDER` (the DI token) stays here because it is Nest-specific.
 */
export {
  EmailMessage,
  EmailProvider,
  SmtpEmailProvider as SharedSmtpEmailProvider,
  LogEmailProvider as SharedLogEmailProvider,
} from '@ems/mailer';

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
