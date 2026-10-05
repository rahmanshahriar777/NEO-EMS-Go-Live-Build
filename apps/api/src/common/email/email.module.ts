import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueuesModule } from '../../core/queues/queues.module';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';
import { SmtpEmailProvider } from './smtp-email.provider';
import { LogEmailProvider } from './log-email.provider';
import { EmailService } from './email.service';

/**
 * B2 — transactional email wiring (global).
 *
 * Provider selection: SMTP when SMTP_HOST is configured, otherwise the dev
 * log fallback. Production boot refuses to start without SMTP_HOST
 * (validateRequiredSecrets), so the fallback can never serve production.
 *
 * The provider instance is exposed for the WORKER's email channel hook via
 * the EMAIL_PROVIDER token. The API itself only enqueues rendered messages
 * through EmailService (notifications queue, channel 'email').
 */
export function createEmailProvider(config: ConfigService): EmailProvider {
  return config.get<boolean>('smtp.enabled', false)
    ? new SmtpEmailProvider(config)
    : new LogEmailProvider();
}

@Global()
@Module({
  imports: [ConfigModule, QueuesModule],
  providers: [
    {
      provide: EMAIL_PROVIDER,
      useFactory: createEmailProvider,
      inject: [ConfigService],
    },
    EmailService,
  ],
  exports: [EMAIL_PROVIDER, EmailService],
})
export class EmailModule {}
