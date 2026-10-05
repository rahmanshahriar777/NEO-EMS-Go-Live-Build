/**
 * Unit tests for the email channel hook (mocked Prisma; REAL SMTP wire).
 *
 * The hook is exercised against a minimal in-process fake SMTP server over
 * the real `sendSmtp` client — no mocking of the mail transport. This proves
 * the full wire path (greeting → EHLO → MAIL/RCPT → DATA → QUIT) and the
 * recipient-resolution order:
 *   1. explicit `data.email` override (e.g. invitation to a not-yet-user),
 *   2. the linked user's account email,
 *   3. otherwise `failed` — never claimed as sent.
 *
 * Email failure semantics (Phase 2 item 2, go-live hardening):
 * - SMTP disabled (no SMTP_HOST): reported `not_configured`, content logged,
 *   never claimed as sent.
 * - SMTP send failure (connection refused): THROWS so BullMQ retries; the
 *   in-app notification row (persisted by the notification processor) is the
 *   guaranteed fallback.
 *
 * Run: npx tsx --test src/processors/email.processor.unit.spec.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { prisma } from '@ems/database';
import { sendEmailChannelHook } from './email.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';

/** Minimal RFC 5321 server: enough for the worker's sendSmtp client. */
class FakeSmtpServer {
  private server = net.createServer();
  connections = 0;
  received: Array<{ mailFrom: string; rcptTo: string; data: string }> = [];

  async start(): Promise<number> {
    this.server.on('connection', (socket) => {
      this.connections += 1;
      socket.write('220 fake-smtp ESMTP\r\n');
      let buffer = '';
      let dataMode = false;
      let mailFrom = '';
      let rcptTo = '';
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (dataMode) {
            if (line === '.') {
              dataMode = false;
              this.received.push({ mailFrom, rcptTo, data });
              data = '';
              socket.write('250 OK: queued\r\n');
            } else {
              data += line + '\r\n';
            }
            continue;
          }
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250 hello\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            mailFrom = line.slice('MAIL FROM:'.length).trim();
            socket.write('250 OK\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            rcptTo = line.slice('RCPT TO:'.length).trim();
            socket.write('250 OK\r\n');
          } else if (upper === 'DATA') {
            dataMode = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else if (upper === 'RSET') {
            socket.write('250 OK\r\n');
          } else {
            socket.write('502 command not implemented\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_FROM', 'SMTP_TIMEOUT_MS'];
let savedEnv: Record<string, string | undefined> = {};

function useSmtpEnv(port: number | null) {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  if (port !== null) {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.EMAIL_FROM = 'ems-test@local';
    process.env.SMTP_TIMEOUT_MS = '2000';
  }
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const payload = (data: any, overrides: any = {}) =>
  ({
    userId: 'user-1',
    channel: 'email',
    template: 'leave-approved',
    data,
    correlationId: 'corr-1',
    ...overrides,
  } as any);

describe('sendEmailChannelHook', () => {
  let smtp: FakeSmtpServer;
  let port: number;

  before(async () => {
    smtp = new FakeSmtpServer();
    port = await smtp.start();
  });

  after(async () => {
    await smtp.stop();
  });

  test('explicit data.email override is used; delivered over the real wire', async (t) => {
    useSmtpEnv(port);
    t.after(restoreEnv);
    smtp.received.length = 0;
    const findUnique = stubPrisma(prisma.user, 'findUnique', async () => {
      throw new Error('should not look up the user when data.email is set');
    }, t);

    const res = await sendEmailChannelHook(payload({ email: 'invitee@example.com', title: 'Hi', message: 'body' }));

    assert.equal(res.status, 'delivered');
    assert.match(res.detail!, /invitee@example\.com/);
    assert.equal(findUnique.calls.length, 0);
    assert.equal(smtp.received.length, 1);
    assert.equal(smtp.received[0].rcptTo, '<invitee@example.com>');
    assert.equal(smtp.received[0].mailFrom, '<ems-test@local>');
    assert.match(smtp.received[0].data, /Hi/);
  });

  test('falls back to the linked user account email', async (t) => {
    useSmtpEnv(port);
    t.after(restoreEnv);
    smtp.received.length = 0;
    const findUnique = stubPrisma(prisma.user, 'findUnique', async () => ({ email: 'acct@example.com' }), t);

    const res = await sendEmailChannelHook(payload({ title: 'Hi', message: 'body' }));

    assert.equal(res.status, 'delivered');
    assert.equal(findUnique.calls.length, 1);
    assert.deepEqual(findUnique.calls[0][0], {
      where: { id: 'user-1' },
      select: { email: true },
    });
    assert.equal(smtp.received[0].rcptTo, '<acct@example.com>');
  });

  test('no recipient anywhere: failed, never sent', async (t) => {
    useSmtpEnv(port);
    t.after(restoreEnv);
    const before = smtp.connections;
    stubPrisma(prisma.user, 'findUnique', async () => null, t);

    const res = await sendEmailChannelHook(payload({ title: 'Hi' }));

    assert.equal(res.status, 'failed');
    assert.match(res.detail!, /No recipient address/);
    assert.equal(smtp.connections, before, 'sendSmtp must not be reached without a recipient');
  });

  test('SMTP disabled: not_configured, content logged not sent', async (t) => {
    useSmtpEnv(null); // SMTP_HOST unset
    t.after(restoreEnv);
    const before = smtp.connections;
    stubPrisma(prisma.user, 'findUnique', async () => ({ email: 'acct@example.com' }), t);

    const res = await sendEmailChannelHook(payload({ title: 'Hi', message: 'body' }));

    assert.equal(res.status, 'not_configured');
    assert.match(res.detail!, /SMTP_HOST is not set/);
    assert.equal(smtp.connections, before);
  });

  test('SMTP connection refused: THROWS so BullMQ retries (fail-loud)', async (t) => {
    useSmtpEnv(1); // port 1: nothing listens -> ECONNREFUSED
    t.after(restoreEnv);
    stubPrisma(prisma.user, 'findUnique', async () => ({ email: 'acct@example.com' }), t);

    // Phase 2 item 2: the transport failure must throw (the in-app copy is
    // already persisted as the fallback; the notification processor converts
    // this into a BullMQ retry).
    await assert.rejects(
      sendEmailChannelHook(payload({ title: 'Hi', message: 'body' })),
      /Email channel failed/,
    );
  });
});
