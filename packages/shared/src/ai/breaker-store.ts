import {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitState,
} from './circuit-breaker.js';

/**
 * Redis-backed circuit-breaker state (go-live hardening, §5 scalability).
 *
 * The per-process `Map<string, CircuitBreaker>` meant every API replica (and
 * the worker) kept its own breaker state: one replica could hammer a dead
 * provider while another had its circuit open. This store keeps the state in
 * Redis so all replicas share one view of each provider's health.
 *
 * Design notes:
 * - State lives in a Redis hash per provider: `ems:ai:circuit:<name>` with
 *   fields `state | failures | halfOpenAttempts | lastFailureAt |
 *   lastStateChange`. A 7-day TTL keeps keys for retired providers from
 *   lingering forever.
 * - All transitions run as single Lua scripts (one round trip, atomic):
 *   `canExecute` also performs the half-open probe accounting that the sync
 *   breaker's `registerAttempt()` did, so the async failover loop must NOT
 *   double-count (the Redis breaker's `registerAttempt()` is a no-op).
 * - The store takes a structural `RedisEvalClient` (just `eval`), not
 *   ioredis directly, so `@ems/shared` stays free of the ioredis
 *   dependency; the API adapts its ioredis client at the call site.
 * - Degradation: if Redis is unreachable the API falls back to
 *   `InMemoryBreakerStore` (previous per-process behaviour) and logs loudly
 *   — the breaker still protects the process, it just isn't shared.
 */

export interface BreakerSnapshot {
  name: string;
  state: CircuitState;
  failureCount: number;
  failureThreshold: number;
  recoveryWindowMs: number;
  lastStateChange: string | null;
}

/** Async breaker — same semantics as the sync CircuitBreaker, promise-based. */
export interface AsyncBreaker {
  readonly name: string;
  canExecute(): Promise<boolean>;
  /** No-op for the Redis breaker (probe accounting is atomic in canExecute). */
  registerAttempt(): Promise<void>;
  recordSuccess(): Promise<void>;
  recordFailure(): Promise<void>;
  getState(): Promise<CircuitState>;
  getSnapshot(): Promise<BreakerSnapshot>;
}

export interface BreakerStore {
  /** Long-lived breaker for `name`; the same instance/state every call. */
  getBreaker(name: string): AsyncBreaker;
}

/** Minimal Redis surface: a single EVAL. ioredis satisfies this structurally. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const KEY_TTL_SECONDS = 7 * 24 * 3600;

/** canExecute + half-open probe accounting, atomically. Returns 1/0. */
const LUA_CAN_EXECUTE = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then state = 'CLOSED' end
local now = tonumber(ARGV[1])
if state == 'OPEN' then
  local lastFailure = tonumber(redis.call('HGET', KEYS[1], 'lastFailureAt') or '0')
  if now - lastFailure >= tonumber(ARGV[2]) then
    state = 'HALF_OPEN'
    redis.call('HSET', KEYS[1], 'state', 'HALF_OPEN', 'halfOpenAttempts', '0', 'lastStateChange', ARGV[1])
  end
end
if state == 'CLOSED' then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 1
end
if state == 'HALF_OPEN' then
  local attempts = tonumber(redis.call('HGET', KEYS[1], 'halfOpenAttempts') or '0')
  if attempts < tonumber(ARGV[3]) then
    redis.call('HINCRBY', KEYS[1], 'halfOpenAttempts', 1)
    redis.call('EXPIRE', KEYS[1], ARGV[4])
    return 1
  end
  return 0
end
return 0
`;

/** Lazy OPEN -> HALF_OPEN transition on read; returns the state. */
const LUA_GET_STATE = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return 'CLOSED' end
if state == 'OPEN' then
  local lastFailure = tonumber(redis.call('HGET', KEYS[1], 'lastFailureAt') or '0')
  if tonumber(ARGV[1]) - lastFailure >= tonumber(ARGV[2]) then
    redis.call('HSET', KEYS[1], 'state', 'HALF_OPEN', 'halfOpenAttempts', '0', 'lastStateChange', ARGV[1])
    return 'HALF_OPEN'
  end
end
return state
`;

const LUA_RECORD_SUCCESS = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then state = 'CLOSED' end
if state == 'HALF_OPEN' then
  redis.call('HSET', KEYS[1], 'state', 'CLOSED', 'failures', '0', 'halfOpenAttempts', '0', 'lastStateChange', ARGV[1])
elseif state == 'CLOSED' then
  redis.call('HSET', KEYS[1], 'failures', '0')
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const LUA_RECORD_FAILURE = `
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
redis.call('HSET', KEYS[1], 'lastFailureAt', ARGV[1])
local state = redis.call('HGET', KEYS[1], 'state')
if not state then state = 'CLOSED' end
if state == 'HALF_OPEN' then
  redis.call('HSET', KEYS[1], 'state', 'OPEN', 'lastStateChange', ARGV[1])
elseif state == 'CLOSED' and failures >= tonumber(ARGV[2]) then
  redis.call('HSET', KEYS[1], 'state', 'OPEN', 'lastStateChange', ARGV[1])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return failures
`;

export class RedisBreakerStore implements BreakerStore {
  private readonly breakers = new Map<string, AsyncBreaker>();

  constructor(
    private readonly redis: RedisEvalClient,
    private readonly config: CircuitBreakerConfig,
    private readonly keyPrefix = 'ems:ai:circuit:',
  ) {}

  getBreaker(name: string): AsyncBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new RedisBreaker(
        this.redis,
        this.keyPrefix + name,
        name,
        this.config,
      );
      this.breakers.set(name, breaker);
    }
    return breaker;
  }
}

class RedisBreaker implements AsyncBreaker {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly key: string,
    readonly name: string,
    private readonly config: CircuitBreakerConfig,
  ) {}

  async canExecute(): Promise<boolean> {
    const result = await this.redis.eval(
      LUA_CAN_EXECUTE,
      1,
      this.key,
      Date.now(),
      this.config.recoveryWindowMs,
      this.config.halfOpenLimit,
      KEY_TTL_SECONDS,
    );
    return Number(result) === 1;
  }

  /** No-op: probe accounting happened atomically inside canExecute. */
  async registerAttempt(): Promise<void> {}

  async recordSuccess(): Promise<void> {
    await this.redis.eval(LUA_RECORD_SUCCESS, 1, this.key, Date.now(), KEY_TTL_SECONDS);
  }

  async recordFailure(): Promise<void> {
    await this.redis.eval(
      LUA_RECORD_FAILURE,
      1,
      this.key,
      Date.now(),
      this.config.failureThreshold,
      KEY_TTL_SECONDS,
    );
  }

  async getState(): Promise<CircuitState> {
    const result = await this.redis.eval(
      LUA_GET_STATE,
      1,
      this.key,
      Date.now(),
      this.config.recoveryWindowMs,
    );
    return String(result) as CircuitState;
  }

  async getSnapshot(): Promise<BreakerSnapshot> {
    const raw = (await this.redis.eval(
      'return redis.call(\'HGETALL\', KEYS[1])',
      1,
      this.key,
    )) as string[];
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
    const lastStateChange = fields['lastStateChange']
      ? new Date(Number(fields['lastStateChange'])).toISOString()
      : null;
    return {
      name: this.name,
      state: await this.getState(),
      failureCount: Number(fields['failures'] ?? 0),
      failureThreshold: this.config.failureThreshold,
      recoveryWindowMs: this.config.recoveryWindowMs,
      lastStateChange,
    };
  }
}

/**
 * Previous behaviour, kept as the explicit fallback: per-process breaker
 * state. Used when Redis is unreachable so the breaker still protects the
 * process (it just isn't shared across replicas).
 */
export class InMemoryBreakerStore implements BreakerStore {
  private readonly breakers = new Map<string, AsyncBreaker>();

  constructor(private readonly config: CircuitBreakerConfig) {}

  getBreaker(name: string): AsyncBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new InMemoryBreakerAdapter(
        name,
        new CircuitBreaker(name, this.config),
      );
      this.breakers.set(name, breaker);
    }
    return breaker;
  }
}

class InMemoryBreakerAdapter implements AsyncBreaker {
  constructor(
    readonly name: string,
    private readonly inner: CircuitBreaker,
  ) {}

  async canExecute(): Promise<boolean> {
    return this.inner.canExecute();
  }
  async registerAttempt(): Promise<void> {
    this.inner.registerAttempt();
  }
  async recordSuccess(): Promise<void> {
    this.inner.recordSuccess();
  }
  async recordFailure(): Promise<void> {
    this.inner.recordFailure();
  }
  async getState(): Promise<CircuitState> {
    return this.inner.getState();
  }
  async getSnapshot(): Promise<BreakerSnapshot> {
    const snap = this.inner.getSnapshot();
    return {
      name: this.name,
      state: snap.state,
      failureCount: snap.failureCount,
      failureThreshold: snap.failureThreshold,
      recoveryWindowMs: snap.recoveryWindowMs,
      lastStateChange: snap.lastStateChange,
    };
  }
}
