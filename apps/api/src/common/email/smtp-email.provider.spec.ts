import { ConfigService } from '@nestjs/config';
import { SmtpEmailProvider } from './smtp-email.provider';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn((opts: any) => ({
    __options: opts,
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  })),
}));

const config = (values: Record<string, any>) =>
  ({
    get: (key: string, def?: any) =>
      key in values ? values[key] : def,
  }) as ConfigService;

describe('SmtpEmailProvider', () => {
  it('throws when SMTP_HOST is not configured (fail-closed)', () => {
    expect(() => new SmtpEmailProvider(config({}))).toThrow(/SMTP_HOST/);
  });

  it('builds a transport with auth when user/pass are set', () => {
    const nodemailer = jest.requireMock('nodemailer') as any;
    const provider = new SmtpEmailProvider(
      config({ 'smtp.host': 'mail.example.com', 'smtp.port': 587, 'smtp.user': 'u', 'smtp.pass': 'p' }),
    );
    expect(provider.name).toBe('smtp');
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'mail.example.com',
        auth: { user: 'u', pass: 'p' },
        connectionTimeout: 10_000,
      }),
    );
  });

  it('omits auth when no credentials are configured', () => {
    const nodemailer = jest.requireMock('nodemailer') as any;
    nodemailer.createTransport.mockClear();
    new SmtpEmailProvider(config({ 'smtp.host': 'relay.local' }));
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    );
  });

  it('send() delivers from/to/subject via the transporter', async () => {
    const nodemailer = jest.requireMock('nodemailer') as any;
    nodemailer.createTransport.mockClear();
    const provider = new SmtpEmailProvider(
      config({ 'smtp.host': 'relay.local', 'smtp.from': 'hr@ems.local' }),
    );
    const transporter = nodemailer.createTransport.mock.results[0].value;
    await provider.send({
      to: 'jane@ems.local',
      subject: 'Welcome',
      text: 'hello',
    } as any);
    expect(transporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'hr@ems.local',
        to: 'jane@ems.local',
        subject: 'Welcome',
      }),
    );
  });

  it('propagates transport failures so BullMQ retries', async () => {
    const nodemailer = jest.requireMock('nodemailer') as any;
    nodemailer.createTransport.mockClear();
    const provider = new SmtpEmailProvider(config({ 'smtp.host': 'relay.local' }));
    const transporter = nodemailer.createTransport.mock.results[0].value;
    transporter.sendMail.mockRejectedValueOnce(new Error('relay down'));
    await expect(provider.send({ to: 'a@b.c', subject: 'x', text: 'y' } as any)).rejects.toThrow(
      /relay down/,
    );
  });
});
