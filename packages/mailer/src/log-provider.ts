import { EmailMessage, EmailProvider } from './types.js';

/**
 * Dev-only fallback EmailProvider.
 *
 * Logs the rendered message instead of sending it. Production boot must
 * refuse to select this (the API's validateRequiredSecrets() already does);
 * it must never be mistaken for a delivery.
 */
export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';

  async send(message: EmailMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `[dev email fallback → ${message.to}] subject="${message.subject}"\n${message.text ?? ''}`,
    );
  }
}
