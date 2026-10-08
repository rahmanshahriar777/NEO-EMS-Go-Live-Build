import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailMessage, SmtpEmailProvider as SharedSmtpEmailProvider } from '@ems/mailer';

/**
 * B2 — SMTP EmailProvider (thin Nest adapter).
 *
 * The real implementation is the shared `SmtpEmailProvider` in the dedicated
 * `@ems/mailer` package (single email implementation — the worker uses the
 * same class). This adapter only maps NestJS ConfigService keys to
 * the shared config object and adds a Nest-style log line.
 *
 * Configuration: SMTP_HOST/PORT/SECURE/USER/PASS/FROM (via the `smtp.*`
 * config namespace). Throws at construction when SMTP_HOST is unset
 * (fail-closed); `send()` throws on transport failure so BullMQ retries.
 */
@Injectable()
export class SmtpEmailProvider extends SharedSmtpEmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);

  constructor(configService: ConfigService) {
    super({
      host: configService.get<string>('smtp.host', ''),
      port: configService.get<number>('smtp.port', 465),
      secure: configService.get<boolean>('smtp.secure', true),
      user: configService.get<string>('smtp.user'),
      pass: configService.get<string>('smtp.pass'),
      from: configService.get<string>('smtp.from', 'shahriar@neotericdigitalbd.com'),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await super.send(message);
    this.logger.log(`Email sent via SMTP to ${message.to} (subject: ${message.subject})`);
  }
}
