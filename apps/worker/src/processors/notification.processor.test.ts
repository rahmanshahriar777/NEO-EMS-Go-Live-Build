/**
 * Unit tests for the notification processor (mocked Prisma).
 *
 * Covers:
 * - input validation (template always required; userId required for
 *   non-email channels),
 * - in-app channel: persist-first, reported delivered,
 * - sms/email channel with no provider wired: in-app record still persisted,
 *   channel reported honestly as `not_configured` (never claimed as sent),
 * - email channel with a hook: the hook's result is returned verbatim,
 * - hook failure: caught, reported as `failed`, and RETHROWN so BullMQ
 *   retries (Phase 2 item 2 — fail-loud; the in-app copy is already
 *   persisted as the fallback),
 * - email-only jobs (no userId, e.g. scheduled reports to raw addresses):
 *   the in-app persist is skipped; the email hook resolves the recipient
 *   from `data.email`,
 * - HIGH #2 regression: producer → consumer round trip — the exact
 *   payloads the API's QueueService builds (notify() email copies and
 *   runScheduledReports() emails) are fed to processNotification with the
 *   REAL email channel hook and a fake SMTP wire, proving the email is
 *   actually delivered (the deleted standalone `email` queue had no
 *   consumer, so these were silently lost).
 *
 * Run: npx tsx --test src/processors/notification.processor.unit.spec.ts
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@ems/database';
import {
  processNotification,
  registerChannelHook,
  type ChannelHook,
  type ChannelResult,
} from './notification.processor.js';
import { sendEmailChannelHook } from './email.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';
import { FakeSmtpServer } from '../test-utils/fake-smtp.helper.js';
import type { NotificationJobPayload } from '@ems/shared';

const job = (data: Partial<NotificationJobPayload>) =>
  ({ id: 'job-1', data } as any);

const basePayload = (overrides: Partial<NotificationJobPayload> = {}): NotificationJobPayload => ({
  userId: 'user-1',
  channel: 'in-app',
  template: 'leave-approved',
  data: { title: 'Leave approved', message: 'Your leave was approved.' },
  correlationId: 'corr-1',
  ...overrides,
});

describe('processNotification', () => {
  test('throws when userId is missing for a non-email channel', async (t) => {
    stubPrisma(prisma.notification, 'create', async () => ({ id: 'n-1' }), t);
    await assert.rejects(
      processNotification(job(basePayload({ userId: undefined, channel: 'in-app' }))),
      /requires a userId/,
    );
  });

  test('throws when template is missing', async (t) => {
    stubPrisma(prisma.notification, 'create', async () => ({ id: 'n-1' }), t);
    await assert.rejects(
      processNotification(job(basePayload({ template: '' as any }))),
      /template is required/,
    );
  });

  test('email channel without userId skips the in-app persist (email-only job)', async (t) => {
    const create = stubPrisma(prisma.notification, 'create', async () => ({ id: 'n-x' }), t);
    let seenPayload: NotificationJobPayload | undefined;
    registerChannelHook('email', async (payload) => {
      seenPayload = payload;
      return { channel: 'email', status: 'delivered', detail: 'ok' } as ChannelResult;
    });

    const out = await processNotification(
      job({
        userId: undefined,
        channel: 'email',
        template: 'scheduled-report',
        data: { email: 'raw@example.com', subject: 'S', message: 'M' },
        correlationId: 'c1',
      }),
    );

    assert.equal(create.calls.length, 0, 'user-less jobs must not write an in-app row');
    assert.equal(out.notificationId, null);
    assert.equal(out.channel.status, 'delivered');
    assert.equal(seenPayload?.data.email, 'raw@example.com');
  });

  test('in-app channel: persists the record first and reports delivered', async (t) => {
    const create = stubPrisma(
      prisma.notification,
      'create',
      async (args: any) => ({ id: 'notif-1', ...args.data }),
      t,
    );

    const out = await processNotification(job(basePayload({ channel: 'in-app' })));

    assert.equal(create.calls.length, 1);
    const createArgs = create.calls[0][0];
    assert.equal(createArgs.data.recipientId, 'user-1');
    assert.equal(createArgs.data.title, 'Leave approved');
    assert.equal(createArgs.data.message, 'Your leave was approved.');
    assert.equal(out.notificationId, 'notif-1');
    assert.equal(out.channel.channel, 'in-app');
    assert.equal(out.channel.status, 'delivered');
    assert.match(out.channel.detail!, /persisted as notification notif-1/);
  });

  test('in-app channel: falls back to the template name when no title is given', async (t) => {
    const create = stubPrisma(
      prisma.notification,
      'create',
      async (args: any) => ({ id: 'notif-2', ...args.data }),
      t,
    );

    await processNotification(job(basePayload({ channel: 'in-app', data: {} })));

    const createArgs = create.calls[0][0];
    assert.equal(createArgs.data.title, 'leave-approved');
    assert.equal(createArgs.data.message, '');
  });

  test('channel with no hook: persists the in-app record, reports not_configured', async (t) => {
    // This file never registers an 'sms' hook, so the sms channel exercises
    // the no-hook path without depending on hook-registration ordering.
    const create = stubPrisma(
      prisma.notification,
      'create',
      async (args: any) => ({ id: 'notif-3', ...args.data }),
      t,
    );

    const out = await processNotification(job(basePayload({ channel: 'sms' })));

    assert.equal(create.calls.length, 1, 'in-app record must still be persisted');
    assert.equal(out.channel.channel, 'sms');
    assert.equal(out.channel.status, 'not_configured');
    assert.match(out.channel.detail!, /No sms provider wired/);
    assert.match(out.channel.detail!, /notif-3/);
  });

  test('email channel: registered hook result is returned verbatim', async (t) => {
    stubPrisma(prisma.notification, 'create', async (args: any) => ({ id: 'notif-4', ...args.data }), t);

    let seenPayload: NotificationJobPayload | undefined;
    const hookResult: ChannelResult = {
      channel: 'email',
      status: 'delivered',
      detail: 'sent via test hook',
    };
    const hook: ChannelHook = async (payload) => {
      seenPayload = payload;
      return hookResult;
    };
    registerChannelHook('email', hook);

    const payload = basePayload({ channel: 'email' });
    const out = await processNotification(job(payload));

    assert.equal(seenPayload, payload);
    assert.equal(out.channel, hookResult);
  });

  test('email channel: hook throwing is rethrown so BullMQ retries (fail-loud)', async (t) => {
    stubPrisma(prisma.notification, 'create', async (args: any) => ({ id: 'notif-5', ...args.data }), t);
    registerChannelHook('email', async () => {
      throw new Error('provider exploded');
    });

    // Phase 2 item 2: the channel failure must throw (the in-app row above
    // is already persisted as the fallback).
    await assert.rejects(
      processNotification(job(basePayload({ channel: 'email' }))),
      /Notification channel 'email' failed.*provider exploded/,
    );
  });

  test('channel retry reuses the in-app row instead of duplicating it', async (t) => {
    const create = stubPrisma(
      prisma.notification,
      'create',
      async (args: any) => ({ id: 'notif-6', ...args.data }),
      t,
    );
    stubPrisma(
      prisma.notification,
      'findFirst',
      async () => ({ id: 'notif-6-earlier' }),
      t,
    );
    registerChannelHook('email', async () => ({
      channel: 'email',
      status: 'delivered',
    }) as ChannelResult);

    const retryJob = { id: 'job-1', attemptsMade: 2, data: basePayload({ channel: 'email' }) } as any;
    const out = await processNotification(retryJob);

    assert.equal(create.calls.length, 0, 'must not create a duplicate in-app row on retry');
    assert.equal(out.notificationId, 'notif-6-earlier');
    assert.equal(out.channel.status, 'delivered');
  });
});

/**
 * HIGH #2 regression: the deleted standalone `email` queue had a producer
 * but no consumer, so every email copy was silently lost. These tests prove
 * the replacement path end to end: the EXACT payloads the API builds via
 * QueueService.enqueueNotification are fed to processNotification with the
 * REAL email channel hook (as main.ts registers it) and a fake SMTP wire.
 * If the consumer stops consuming, these fail.
 */
describe('producer → consumer email round trip', () => {
  let smtp: FakeSmtpServer;
  let port: number;

  const ENV_KEYS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
    'EMAIL_FROM',
    'SMTP_FROM',
    'SMTP_TIMEOUT_MS',
  ];
  let savedEnv: Record<string, string | undefined> = {};

  function useSmtpEnv() {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.EMAIL_FROM = 'ems-test@local';
    process.env.SMTP_TIMEOUT_MS = '2000';
  }

  function restoreEnv() {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }

  before(async () => {
    smtp = new FakeSmtpServer();
    port = await smtp.start();
  });

  after(async () => {
    await smtp.stop();
  });

  test('notify() email copy: in-app persisted once, email delivered to data.email', async (t) => {
    useSmtpEnv();
    t.after(restoreEnv);
    smtp.received.length = 0;
    const create = stubPrisma(
      prisma.notification,
      'create',
      async (args: any) => ({ id: 'notif-rt-1', ...args.data }),
      t,
    );
    const findUnique = stubPrisma(prisma.user, 'findUnique', async () => {
      throw new Error('must not look up the user when data.email is set');
    }, t);
    registerChannelHook('email', sendEmailChannelHook);

    // Payload shaped EXACTLY as NotificationsService.notify() builds it via
    // QueueService.enqueueNotification(userId, 'email', template, data, …).
    const out = await processNotification(
      job({
        userId: 'user-1',
        channel: 'email',
        template: 'leave-request-approved',
        data: {
          email: 'ada@example.com',
          subject: 'Leave request approved',
          title: 'Leave request approved',
          message: 'Your leave was approved.',
          linkUrl: '/leaves/req-1',
        },
        correlationId: 'corr-rt-1',
      }),
    );

    assert.equal(create.calls.length, 1, 'in-app row persisted exactly once (no duplicates)');
    assert.equal(create.calls[0][0].data.recipientId, 'user-1');
    assert.equal(create.calls[0][0].data.title, 'Leave request approved');
    assert.equal(findUnique.calls.length, 0, 'explicit data.email wins; no user lookup');
    assert.equal(out.channel.status, 'delivered');
    assert.equal(smtp.received.length, 1, 'the email actually left the worker');
    assert.equal(smtp.received[0].rcptTo, '<ada@example.com>');
    assert.match(smtp.received[0].data, /Your leave was approved\./);
  });

  test('runScheduledReports() email: no in-app row, PDF/CSV attachment delivered', async (t) => {
    useSmtpEnv();
    t.after(restoreEnv);
    smtp.received.length = 0;
    const create = stubPrisma(prisma.notification, 'create', async () => {
      throw new Error('email-only jobs must not persist an in-app row');
    }, t);
    registerChannelHook('email', sendEmailChannelHook);

    // Payload shaped EXACTLY as ReportsService.runScheduledReports() builds it.
    const csv = 'Metric,Value\nTotal headcount,4\n';
    const out = await processNotification(
      job({
        userId: undefined,
        channel: 'email',
        template: 'scheduled-report',
        data: {
          email: 'a@x.com',
          subject: 'Scheduled report: headcount',
          title: 'Scheduled report: headcount',
          message: 'Attached: headcount-2026-10-05.csv (generated 2026-10-05T00:00:00.000Z).',
          attachment: {
            filename: 'headcount-2026-10-05.csv',
            contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
          },
        },
        correlationId: 'corr-rt-2',
      }),
    );

    assert.equal(create.calls.length, 0);
    assert.equal(out.notificationId, null);
    assert.equal(out.channel.status, 'delivered');
    assert.equal(smtp.received.length, 1, 'the report email actually left the worker');
    assert.equal(smtp.received[0].rcptTo, '<a@x.com>');
    assert.match(smtp.received[0].data, /filename=headcount-2026-10-05\.csv/);
    assert.ok(
      smtp.received[0].data.includes(Buffer.from(csv, 'utf8').toString('base64')),
      'attachment bytes must travel in the MIME body',
    );
  });
});
