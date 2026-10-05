import { CircuitBreaker } from './circuit-breaker.js';
import { AsyncBreaker, BreakerStore } from './breaker-store.js';
import {
  AiGenerateOptions,
  AiProviderInvoker,
  AiProviderResult,
  AiProviderUsage,
} from './types.js';

/**
 * Shared AI failover orchestration — the single implementation both the API's
 * `AiOrchestratorService` and the worker's AI processor should use, so the
 * breaker behaviour can never drift between the sync and async paths.
 *
 * Flow: try providers in order; skip any whose circuit breaker is OPEN;
 * record success/failure per attempt; return the first success. Throws
 * `AllProvidersFailedError` when every provider is unavailable.
 */

export interface FailoverAttempt {
  provider: string;
  model: string;
  error: string;
  latencyMs: number;
}

export interface FailoverResult extends AiProviderResult {
  failoverUsed: boolean;
  failoverReason?: string;
  attempts: FailoverAttempt[];
  usage?: AiProviderUsage;
}

export interface FailoverContext {
  providers: AiProviderInvoker[];
  breakers: Map<string, CircuitBreaker>;
  logger?: {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

export class AllProvidersFailedError extends Error {
  readonly attempts: FailoverAttempt[];
  constructor(attempts: FailoverAttempt[]) {
    super('All configured AI providers are currently unavailable or in open circuit state.');
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
  }
}

/**
 * Ensure a CircuitBreaker exists for every provider in the context.
 * Callers that keep long-lived breaker state (e.g. the API orchestrator)
 * should reuse the same map across calls; the worker keeps one per process.
 */
export function ensureBreakers(
  ctx: FailoverContext,
  config: { failureThreshold: number; recoveryWindowMs: number; halfOpenLimit: number },
): void {
  for (const provider of ctx.providers) {
    if (!ctx.breakers.has(provider.name)) {
      ctx.breakers.set(provider.name, new CircuitBreaker(provider.name, config));
    }
  }
}

export async function generateWithFailover(
  prompt: string,
  options: AiGenerateOptions = {},
  ctx: FailoverContext,
): Promise<FailoverResult> {
  const log = ctx.logger ?? { log: () => {}, warn: () => {}, error: () => {} };
  const attempts: FailoverAttempt[] = [];
  let failoverUsed = false;
  let failoverReason: string | undefined;
  const overallStart = Date.now();

  for (let i = 0; i < ctx.providers.length; i++) {
    const provider = ctx.providers[i];
    const isFailoverAttempt = i > 0;
    const breaker = ctx.breakers.get(provider.name);
    if (!breaker) {
      throw new Error(`No circuit breaker registered for provider "${provider.name}". Call ensureBreakers() first.`);
    }

    if (!breaker.canExecute()) {
      const skipReason = `Circuit breaker for ${provider.name} is ${breaker.getState()}. Skipping.`;
      log.warn(skipReason);
      attempts.push({ provider: provider.name, model: options.model || provider.defaultModel, error: skipReason, latencyMs: 0 });
      if (!isFailoverAttempt) {
        failoverUsed = true;
        failoverReason = skipReason;
      }
      continue;
    }

    breaker.registerAttempt();
    const attemptStart = Date.now();
    try {
      log.log(`Dispatching AI request to ${provider.name} (model: ${options.model || provider.defaultModel})`);
      const result = await provider.generate(prompt, options);
      breaker.recordSuccess();
      if (isFailoverAttempt) failoverUsed = true;
      log.log(`AI generation succeeded via ${provider.name} in ${Date.now() - attemptStart}ms (failover: ${failoverUsed})`);
      return {
        ...result,
        latencyMs: Date.now() - overallStart,
        failoverUsed,
        failoverReason,
        attempts,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - attemptStart;
      const errorMsg = err?.message || 'Unknown provider error';
      breaker.recordFailure();
      log.warn(`Provider ${provider.name} failed in ${latencyMs}ms: "${errorMsg}"`);
      attempts.push({ provider: provider.name, model: options.model || provider.defaultModel, error: errorMsg, latencyMs });
      if (!isFailoverAttempt) {
        failoverUsed = true;
        failoverReason = `${provider.name} failure: ${errorMsg}`;
      }
    }
  }

  log.error(`All AI providers failed. Attempts: ${JSON.stringify(attempts)}`);
  throw new AllProvidersFailedError(attempts);
}

// ---------------------------------------------------------------------------
// Async variant: same failover semantics, but breaker state comes from a
// BreakerStore (Redis-backed, shared across replicas) instead of a
// per-process Map. The API orchestrator uses this; the sync version above
// stays for callers without async breaker state.
// ---------------------------------------------------------------------------

export interface AsyncFailoverContext {
  providers: AiProviderInvoker[];
  store: BreakerStore;
  logger?: {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

export async function generateWithFailoverAsync(
  prompt: string,
  options: AiGenerateOptions = {},
  ctx: AsyncFailoverContext,
): Promise<FailoverResult> {
  const log = ctx.logger ?? { log: () => {}, warn: () => {}, error: () => {} };
  const attempts: FailoverAttempt[] = [];
  let failoverUsed = false;
  let failoverReason: string | undefined;
  const overallStart = Date.now();

  for (let i = 0; i < ctx.providers.length; i++) {
    const provider = ctx.providers[i];
    const isFailoverAttempt = i > 0;
    const breaker: AsyncBreaker = ctx.store.getBreaker(provider.name);

    if (!(await breaker.canExecute())) {
      const skipReason = `Circuit breaker for ${provider.name} is ${await breaker.getState()}. Skipping.`;
      log.warn(skipReason);
      attempts.push({ provider: provider.name, model: options.model || provider.defaultModel, error: skipReason, latencyMs: 0 });
      if (!isFailoverAttempt) {
        failoverUsed = true;
        failoverReason = skipReason;
      }
      continue;
    }

    await breaker.registerAttempt();
    const attemptStart = Date.now();
    try {
      log.log(`Dispatching AI request to ${provider.name} (model: ${options.model || provider.defaultModel})`);
      const result = await provider.generate(prompt, options);
      await breaker.recordSuccess();
      if (isFailoverAttempt) failoverUsed = true;
      log.log(`AI generation succeeded via ${provider.name} in ${Date.now() - attemptStart}ms (failover: ${failoverUsed})`);
      return {
        ...result,
        latencyMs: Date.now() - overallStart,
        failoverUsed,
        failoverReason,
        attempts,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - attemptStart;
      const errorMsg = err?.message || 'Unknown provider error';
      await breaker.recordFailure();
      log.warn(`Provider ${provider.name} failed in ${latencyMs}ms: "${errorMsg}"`);
      attempts.push({ provider: provider.name, model: options.model || provider.defaultModel, error: errorMsg, latencyMs });
      if (!isFailoverAttempt) {
        failoverUsed = true;
        failoverReason = `${provider.name} failure: ${errorMsg}`;
      }
    }
  }

  log.error(`All AI providers failed. Attempts: ${JSON.stringify(attempts)}`);
  throw new AllProvidersFailedError(attempts);
}
