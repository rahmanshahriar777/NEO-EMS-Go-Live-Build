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
import { prisma } from '@ems/database';
import { sendEmailChannelHook } from './email.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';
import { FakeSmtpServer } from '../test-utils/fake-smtp.helper.js';

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

  test('data.attachment is delivered as a MIME attachment (scheduled reports)', async (t) => {
    useSmtpEnv(port);
    t.after(restoreEnv);
    smtp.received.length = 0;
    stubPrisma(prisma.user, 'findUnique', async () => ({ email: 'acct@example.com' }), t);

    const csv = 'Metric,Value\nTotal headcount,4\n';
    const res = await sendEmailChannelHook(
      payload({
        email: 'reports@example.com',
        subject: 'Scheduled report: headcount',
        title: 'Scheduled report: headcount',
        message: 'Attached: headcount-2026-10-05.csv (generated ...).',
        attachment: {
          filename: 'headcount-2026-10-05.csv',
          contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
          contentType: 'text/csv',
        },
      }),
    );

    assert.equal(res.status, 'delivered');
    assert.equal(smtp.received.length, 1);
    const raw = smtp.received[0].data;
    assert.equal(smtp.received[0].rcptTo, '<reports@example.com>');
    assert.match(raw, /filename=headcount-2026-10-05\.csv/);
    assert.ok(
      raw.includes(Buffer.from(csv, 'utf8').toString('base64')),
      'attachment bytes must travel in the MIME body',
    );
  });

  test('malformed attachment is skipped loudly, email still delivered', async (t) => {
    useSmtpEnv(port);
    t.after(restoreEnv);
    smtp.received.length = 0;
    stubPrisma(prisma.user, 'findUnique', async () => ({ email: 'acct@example.com' }), t);

    const res = await sendEmailChannelHook(
      payload({
        email: 'reports@example.com',
        title: 'Hi',
        message: 'body',
        attachment: { filename: 'broken.csv' }, // no contentBase64
      }),
    );

    assert.equal(res.status, 'delivered');
    assert.equal(smtp.received.length, 1);
    assert.doesNotMatch(smtp.received[0].data, /broken\.csv/);
  });
});
