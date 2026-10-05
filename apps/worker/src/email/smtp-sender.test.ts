/**
 * Unit tests for the worker's email sender (thin adapter over the shared
 * nodemailer provider in @ems/shared).
 * Run with: tsx --test src/email/smtp-sender.test.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import {
  createSmtpProvider,
  resolveSmtpConfig,
  sendSmtp,
} from './smtp-sender.js';

describe('resolveSmtpConfig', () => {
  test('returns null when SMTP_HOST is unset (dev-log fallback)', () => {
    assert.equal(resolveSmtpConfig({}), null);
    assert.equal(resolveSmtpConfig({ SMTP_HOST: '  ' }), null);
  });

  test('parses host/port/secure/credentials with defaults', () => {
    const cfg = resolveSmtpConfig({
      SMTP_HOST: 'mail.example.com',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      EMAIL_FROM: 'hr@example.com',
    })!;
    assert.equal(cfg.host, 'mail.example.com');
    assert.equal(cfg.port, 587);
    assert.equal(cfg.secure, false);
    assert.equal(cfg.user, 'u');
    assert.equal(cfg.pass, 'p');
    assert.equal(cfg.from, 'hr@example.com');
  });

  test('honours SMTP_PORT and SMTP_SECURE=true', () => {
    const cfg = resolveSmtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_SECURE: 'true' })!;
    assert.equal(cfg.port, 465);
    assert.equal(cfg.secure, true);
  });
});

describe('createSmtpProvider', () => {
  test('builds the shared provider named smtp', () => {
    const provider = createSmtpProvider({
      host: 'mail.example.com',
      port: 587,
      secure: false,
      from: 'no-reply@ems.local',
    });
    assert.equal(provider.name, 'smtp');
  });

  test('throws when the host is missing (fail-closed)', () => {
    assert.throws(
      () =>
        createSmtpProvider({ host: '  ', port: 587, secure: false, from: 'a@b.c' }),
      /SMTP_HOST/,
    );
  });
});

/** Minimal fake SMTP relay: greeting, EHLO, AUTH LOGIN, MAIL/RCPT/DATA, QUIT. */
function startFakeSmtp(opts: { advertiseAuth: boolean; expectUser: string; expectPass: string }) {
  const received: { from?: string; to?: string; data?: string; authed: boolean } = { authed: false };
  const server = net.createServer((socket) => {
    socket.write('220 fake ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    let dataLines: string[] = [];
    let authStage: 0 | 1 | 2 = 0;
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.data = dataLines.join('\r\n');
            dataLines = [];
            socket.write('250 OK: queued\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }
        if (authStage === 1) {
          assert.equal(Buffer.from(line, 'base64').toString('utf8'), opts.expectUser);
          authStage = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStage === 2) {
          assert.equal(Buffer.from(line, 'base64').toString('utf8'), opts.expectPass);
          authStage = 0;
          received.authed = true;
          socket.write('235 Authentication successful\r\n');
        } else if (/^EHLO/i.test(line)) {
          // NB: this fake does not implement STARTTLS, so it must not
          // advertise it — the client upgrades whenever it is offered.
          socket.write(opts.advertiseAuth ? '250-fake\r\n250 AUTH LOGIN\r\n' : '250 fake\r\n');
        } else if (/^AUTH LOGIN/i.test(line)) {
          authStage = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:<(.+)>/.test(line)) {
          received.from = line.match(/^MAIL FROM:<(.+)>/)![1];
          socket.write('250 OK\r\n');
        } else if (/^RCPT TO:<(.+)>/.test(line)) {
          received.to = line.match(/^RCPT TO:<(.+)>/)![1];
          socket.write('250 OK\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 Bye\r\n');
          socket.end();
        } else if (/^RSET/i.test(line)) {
          socket.write('250 OK\r\n');
        } else {
          socket.write('500 unrecognized\r\n');
        }
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        resolve({
          port,
          received,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    },
  );
}

describe('sendSmtp (via shared nodemailer provider)', () => {
  let fake: Awaited<ReturnType<typeof startFakeSmtp>>;
  before(async () => {
    fake = await startFakeSmtp({ advertiseAuth: true, expectUser: 'user', expectPass: 'pass' });
  });
  after(async () => {
    await fake.close();
  });

  test('completes AUTH LOGIN + MAIL/RCPT/DATA against the fake relay', async () => {
    await sendSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false, user: 'user', pass: 'pass', from: 'no-reply@ems.local', timeoutMs: 5000 },
      { to: 'new.hire@example.com', subject: 'Welcome', text: 'welcome aboard' },
    );
    assert.equal(fake.received.from, 'no-reply@ems.local');
    assert.equal(fake.received.to, 'new.hire@example.com');
    assert.equal(fake.received.authed, true);
    assert.ok(fake.received.data!.includes('Subject: Welcome'));
    assert.ok(fake.received.data!.includes('welcome aboard'));
  });

  test('refuses to send without recipient', async () => {
    await assert.rejects(
      sendSmtp(
        { host: '127.0.0.1', port: fake.port, secure: false, from: 'a@b.c', timeoutMs: 2000 },
        { to: '', subject: 'x' },
      ),
      /without recipient/,
    );
  });

  test('refuses to send without subject', async () => {
    await assert.rejects(
      sendSmtp(
        { host: '127.0.0.1', port: fake.port, secure: false, from: 'a@b.c', timeoutMs: 2000 },
        { to: 'x@y.z', subject: '' },
      ),
      /without subject/,
    );
  });

  test('fails loudly when the server rejects the recipient', async () => {
    const rejecting = net.createServer((socket) => {
      socket.write('220 fake\r\n');
      let buf = '';
      socket.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^EHLO/i.test(line)) socket.write('250 fake\r\n');
          else if (/^MAIL FROM/i.test(line)) socket.write('250 OK\r\n');
          else if (/^RCPT TO/i.test(line)) socket.write('550 No such user\r\n');
          else socket.write('500 no\r\n');
        }
      });
    });
    const port = await new Promise<number>((r) =>
      rejecting.listen(0, '127.0.0.1', () => r((rejecting.address() as net.AddressInfo).port)),
    );
    await assert.rejects(
      sendSmtp(
        { host: '127.0.0.1', port, secure: false, from: 'a@b.c', timeoutMs: 5000 },
        { to: 'nobody@example.com', subject: 'x' },
      ),
      /550/,
    );
    await new Promise<void>((r) => rejecting.close(() => r()));
  });
});
