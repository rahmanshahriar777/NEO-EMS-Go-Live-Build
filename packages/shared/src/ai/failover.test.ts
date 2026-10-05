/**
 * Unit tests for the shared circuit breaker + failover core.
 * Run with: tsx --test src/ai/failover.test.ts
 * Uses stubbed invokers — no SDKs, no network, no keys.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  AllProvidersFailedError,
  ensureBreakers,
  generateWithFailover,
  type FailoverContext,
} from './failover.js';
import { withTimeout, type AiProviderInvoker } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ok = (name: string, content = `content-from-${name}`): AiProviderInvoker => ({
  name,
  defaultModel: `${name}-model`,
  generate: async () => ({ content, provider: name, model: `${name}-model`, latencyMs: 1 }),
});

const failing = (name: string, msg = `${name}-boom`): AiProviderInvoker => ({
  name,
  defaultModel: `${name}-model`,
  generate: async () => {
    throw new Error(msg);
  },
});

function makeCtx(providers: AiProviderInvoker[], failureThreshold = 2): FailoverContext {
  const ctx: FailoverContext = { providers, breakers: new Map() };
  ensureBreakers(ctx, { failureThreshold, recoveryWindowMs: 40, halfOpenLimit: 1 });
  return ctx;
}

describe('CircuitBreaker', () => {
  test('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker('p', { failureThreshold: 2, recoveryWindowMs: 60_000, halfOpenLimit: 1 });
    assert.equal(cb.getState(), 'CLOSED');
    cb.recordFailure();
    assert.equal(cb.getState(), 'CLOSED');
    assert.equal(cb.canExecute(), true);
    cb.recordFailure();
    assert.equal(cb.getState(), 'OPEN');
    assert.equal(cb.canExecute(), false);
  });

  test('success resets the failure count', () => {
    const cb = new CircuitBreaker('p', { failureThreshold: 2, recoveryWindowMs: 60_000, halfOpenLimit: 1 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    assert.equal(cb.getState(), 'CLOSED'); // only 1 consecutive failure
  });

  test('half-opens after the recovery window and closes on probe success', async () => {
    const cb = new CircuitBreaker('p', { failureThreshold: 1, recoveryWindowMs: 30, halfOpenLimit: 1 });
    cb.recordFailure();
    assert.equal(cb.canExecute(), false);
    await sleep(50);
    assert.equal(cb.canExecute(), true); // HALF_OPEN probe allowed
    assert.equal(cb.getState(), 'HALF_OPEN');
    cb.recordSuccess();
    assert.equal(cb.getState(), 'CLOSED');
  });

  test('failed half-open probe re-opens the circuit', async () => {
    const cb = new CircuitBreaker('p', { failureThreshold: 1, recoveryWindowMs: 30, halfOpenLimit: 1 });
    cb.recordFailure();
    await sleep(50);
    assert.equal(cb.canExecute(), true);
    cb.registerAttempt();
    cb.recordFailure();
    assert.equal(cb.getState(), 'OPEN');
  });
});

describe('generateWithFailover', () => {
  test('primary success: no failover', async () => {
    const ctx = makeCtx([ok('gemini'), ok('groq')]);
    const res = await generateWithFailover('hi', {}, ctx);
    assert.equal(res.provider, 'gemini');
    assert.equal(res.failoverUsed, false);
    assert.equal(res.attempts.length, 0);
  });

  test('primary failure -> secondary success, failover flagged', async () => {
    const ctx = makeCtx([failing('gemini', 'quota exceeded'), ok('groq')]);
    const res = await generateWithFailover('hi', {}, ctx);
    assert.equal(res.provider, 'groq');
    assert.equal(res.failoverUsed, true);
    assert.match(res.failoverReason || '', /gemini failure: quota exceeded/);
    assert.equal(res.attempts.length, 1);
    assert.equal(res.attempts[0].provider, 'gemini');
  });

  test('all providers fail -> AllProvidersFailedError with attempts', async () => {
    const ctx = makeCtx([failing('gemini'), failing('groq')]);
    await assert.rejects(() => generateWithFailover('hi', {}, ctx), AllProvidersFailedError);
    try {
      await generateWithFailover('hi', {}, ctx);
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.equal(err.attempts.length, 2);
    }
  });

  test('open circuit skips the primary without calling it', async () => {
    const primary = failing('gemini');
    let calls = 0;
    const counting: AiProviderInvoker = {
      ...primary,
      generate: async (...a) => {
        calls++;
        return primary.generate(...a);
      },
    };
    const ctx = makeCtx([counting, ok('groq')], 1);
    // Trip the breaker directly.
    ctx.breakers.get('gemini')!.recordFailure();
    assert.equal(ctx.breakers.get('gemini')!.getState(), 'OPEN');

    const res = await generateWithFailover('hi', {}, ctx);
    assert.equal(res.provider, 'groq');
    assert.equal(calls, 0); // never invoked
    assert.equal(res.failoverUsed, true);
    assert.match(res.failoverReason || '', /Circuit breaker/);
  });
});

describe('withTimeout', () => {
  test('resolves when the promise settles in time', async () => {
    assert.equal(await withTimeout(Promise.resolve(42), 100, 't'), 42);
  });

  test('rejects after the timeout', async () => {
    await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'slow-op'), /slow-op timed out after 20ms/);
  });
});
