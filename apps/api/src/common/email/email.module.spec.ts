import { ConfigService } from '@nestjs/config';
import { createEmailProvider } from './email.module';
import { SmtpEmailProvider } from './smtp-email.provider';
import { LogEmailProvider } from './log-email.provider';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn() })),
}));

const config = (values: Record<string, any>) =>
  ({
    get: (key: string, def?: any) => (key in values ? values[key] : def),
  }) as ConfigService;

describe('createEmailProvider', () => {
  it('selects the SMTP provider when smtp.enabled is true', () => {
    const provider = createEmailProvider(
      config({ 'smtp.enabled': true, 'smtp.host': 'mail.example.com' }),
    );
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });

  it('falls back to the log provider when smtp.enabled is false', () => {
    const provider = createEmailProvider(config({ 'smtp.enabled': false }));
    expect(provider).toBeInstanceOf(LogEmailProvider);
  });

  it('falls back to the log provider when smtp.enabled is unset', () => {
    const provider = createEmailProvider(config({}));
    expect(provider).toBeInstanceOf(LogEmailProvider);
  });
});
