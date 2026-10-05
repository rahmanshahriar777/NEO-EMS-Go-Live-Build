import { Injectable, Logger } from '@nestjs/common';
import {
  EmailMessage,
  LogEmailProvider as SharedLogEmailProvider,
} from '@ems/mailer';

/**
 * B2 — dev-only fallback EmailProvider (thin Nest adapter).
 *
 * Selected when SMTP_HOST is unset (local development, tests). Logs the
 * rendered message instead of sending it. NEVER selected in production:
 * validateRequiredSecrets() refuses to boot in production without SMTP_HOST,
 * so a real provider is always wired there.
 */
@Injectable()
export class LogEmailProvider extends SharedLogEmailProvider {
  private readonly logger = new Logger(LogEmailProvider.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(
      `[dev email fallback → ${message.to}] subject="${message.subject}"\n${message.text ?? ''}`,
    );
  }
}
