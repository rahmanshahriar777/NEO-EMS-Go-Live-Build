import { Logger } from '@nestjs/common';
import {
  AsyncBreaker,
  CircuitState,
  BreakerSnapshot,
  BreakerStore,
  CircuitBreakerConfig,
  InMemoryBreakerStore,
  RedisBreakerStore,
  RedisEvalClient,
} from '@ems/shared';

/**
 * BreakerStore that prefers Redis-backed breaker state (shared across API
 * replicas — go-live hardening, §5 scalability) and degrades to per-process
 * in-memory state when Redis is unreachable.
 *
 * Degradation policy (fail-open for the *sharing* layer only): the breaker
 * itself always protects the process. When a Redis call fails, the failing
 * breaker transparently falls back to its in-memory twin for that call and
 * the store is marked degraded; it re-probes Redis after 60s so recovery is
 * automatic when Redis comes back. Every transition is logged loudly — a
 * fleet silently running on per-process breakers would defeat the purpose.
 */

const REPROBE_AFTER_MS = 60_000;

export class ResilientBreakerStore implements BreakerStore {
  private readonly memory: InMemoryBreakerStore;
  private readonly redisStore: RedisBreakerStore | null;
  private degraded = false;
  private degradedSince = 0;

  constructor(
    redisClient: RedisEvalClient | null,
    private readonly config: CircuitBreakerConfig,
    private readonly logger: Logger,
  ) {
    this.memory = new InMemoryBreakerStore(config);
    this.redisStore = redisClient ? new RedisBreakerStore(redisClient, config) : null;
    if (!redisClient) {
      this.logger.warn(
        '[ai] No Redis client available for circuit-breaker state — using ' +
          'per-process in-memory breakers. Breaker state will NOT be shared ' +
          'across replicas until Redis is reachable.',
      );
    } else {
      this.logger.log('[ai] Circuit-breaker state is Redis-backed (shared across replicas).');
    }
  }

  getBreaker(name: string): AsyncBreaker {
    const fallback = this.memory.getBreaker(name);
    if (!this.redisStore) return fallback;
    if (this.degraded && Date.now() - this.degradedSince < REPROBE_AFTER_MS) {
      return fallback;
    }
    // Re-probe window elapsed (or never degraded): try Redis again.
    if (this.degraded) {
      this.degraded = false;
      this.logger.log('[ai] Re-probing Redis for circuit-breaker state.');
    }
    return new DegradingBreaker(
      this.redisStore.getBreaker(name),
      fallback,
      () => this.markDegraded(name),
    );
  }

  private markDegraded(name: string): void {
    if (!this.degraded) {
      this.degraded = true;
      this.degradedSince = Date.now();
      this.logger.warn(
        `[ai] Circuit-breaker Redis store failed for '${name}' — degraded to ` +
          'per-process in-memory breakers for 60s (breaker still protects this process).',
      );
    }
  }
}

/** AsyncBreaker that falls back to an in-memory twin when Redis calls fail. */
class DegradingBreaker implements AsyncBreaker {
  constructor(
    private readonly primary: AsyncBreaker,
    private readonly fallback: AsyncBreaker,
    private readonly onDegrade: () => void,
  ) {}

  get name(): string {
    return this.primary.name;
  }

  private async withFallback<T>(fn: (b: AsyncBreaker) => Promise<T>): Promise<T> {
    try {
      return await fn(this.primary);
    } catch {
      this.onDegrade();
      return fn(this.fallback);
    }
  }

  canExecute(): Promise<boolean> {
    return this.withFallback((b) => b.canExecute());
  }
  registerAttempt(): Promise<void> {
    return this.withFallback((b) => b.registerAttempt());
  }
  recordSuccess(): Promise<void> {
    return this.withFallback((b) => b.recordSuccess());
  }
  recordFailure(): Promise<void> {
    return this.withFallback((b) => b.recordFailure());
  }
  getState(): Promise<CircuitState> {
    return this.withFallback((b) => b.getState());
  }
  getSnapshot(): Promise<BreakerSnapshot> {
    return this.withFallback((b) => b.getSnapshot());
  }
}
