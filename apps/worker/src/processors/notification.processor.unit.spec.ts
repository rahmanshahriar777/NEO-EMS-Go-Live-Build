/**
 * Unit tests for the notification processor (mocked Prisma).
 *
 * Covers:
 * - input validation (userId + template required),
 * - in-app channel: persist-first, reported delivered,
 * - sms/email channel with no provider wired: in-app record still persisted,
 *   channel reported honestly as `not_configured` (never claimed as sent),
 * - email channel with a hook: the hook's result is returned verbatim,
 * - hook failure: caught, reported as `failed`, and RETHROWN so BullMQ
 *   retries (Phase 2 item 2 — fail-loud; the in-app copy is already
 *   persisted as the fallback).
 *
 * Run: npx tsx --test src/processors/notification.processor.unit.spec.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@ems/database';
import {
  processNotification,
  registerChannelHook,
  type ChannelHook,
  type ChannelResult,
} from './notification.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';
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
  test('throws when userId is missing', async (t) => {
    stubPrisma(prisma.notification, 'create', async () => ({ id: 'n-1' }), t);
    await assert.rejects(
      processNotification(job(basePayload({ userId: '' as any }))),
      /userId and template are required/,
    );
  });

  test('throws when template is missing', async (t) => {
    stubPrisma(prisma.notification, 'create', async () => ({ id: 'n-1' }), t);
    await assert.rejects(
      processNotification(job(basePayload({ template: '' as any }))),
      /userId and template are required/,
    );
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
