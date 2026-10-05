import { RedisThrottlerStorage } from './redis-throttler.storage';
import { RedisService } from '../../core/redis/redis.service';

/**
 * RedisThrottlerStorage tests (B8).
 * The Lua script is exercised against a fake ioredis client that emulates
 * INCR/PEXPIRE/PTTL/SET/EXISTS semantics; failure paths assert fail-open.
 */
describe('RedisThrottlerStorage', () => {
  let storage: RedisThrottlerStorage;
  let redisService: { getClient: jest.Mock; getIsConnected: jest.Mock };
  let evalMock: jest.Mock;

  /** Minimal in-memory emulation of the Lua script's key behaviour. */
  function makeFakeClient() {
    const counters = new Map<string, { hits: number; expireAt: number }>();
    const blocks = new Map<string, number>(); // key -> blockExpireAt
    return {
      eval: jest.fn(async (script: string, numKeys: number, counterKey: string, blockKey: string,
        ttlMs: string, limit: string, blockMs: string) => {
        const now = Date.now();
        const ttl = parseInt(ttlMs, 10);
        const lim = parseInt(limit, 10);
        const bMs = parseInt(blockMs, 10);
        const blockExpire = blocks.get(blockKey) ?? 0;
        if (blockExpire > now) {
          const c = counters.get(counterKey);
          const ttlLeft = c ? Math.max(0, c.expireAt - now) : ttl;
          return [c?.hits ?? 0, ttlLeft, 1, blockExpire - now];
        }
        let c = counters.get(counterKey);
        if (!c || c.expireAt <= now) {
          c = { hits: 0, expireAt: now + ttl };
        }
        c.hits += 1;
        counters.set(counterKey, c);
        const ttlLeft = c.expireAt - now;
        if (c.hits > lim) {
          blocks.set(blockKey, now + bMs);
          return [c.hits, ttlLeft, 1, bMs];
        }
        return [c.hits, ttlLeft, 0, 0];
      }),
    };
  }

  beforeEach(() => {
    evalMock = makeFakeClient().eval;
    redisService = {
      getClient: jest.fn().mockReturnValue({ eval: evalMock }),
      getIsConnected: jest.fn().mockReturnValue(true),
    };
    storage = new RedisThrottlerStorage(redisService as unknown as RedisService);
  });

  it('counts hits and reports not-blocked under the limit', async () => {
    const r1 = await storage.increment('k1', 60_000, 2, 60_000, 'default');
    expect(r1.totalHits).toBe(1);
    expect(r1.isBlocked).toBe(false);

    const r2 = await storage.increment('k1', 60_000, 2, 60_000, 'default');
    expect(r2.totalHits).toBe(2);
    expect(r2.isBlocked).toBe(false);
  });

  it('blocks once hits exceed the limit', async () => {
    await storage.increment('k2', 60_000, 1, 60_000, 'default');
    const r = await storage.increment('k2', 60_000, 1, 60_000, 'default');

    expect(r.totalHits).toBe(2);
    expect(r.isBlocked).toBe(true);
    expect(r.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('keys are namespaced and independent', async () => {
    await storage.increment('user-a', 60_000, 1, 60_000, 'default');
    const other = await storage.increment('user-b', 60_000, 1, 60_000, 'default');

    expect(other.totalHits).toBe(1);
    expect(other.isBlocked).toBe(false);
    // counter key is prefixed so it cannot collide with app keys
    expect(evalMock.mock.calls[0][2]).toBe('throttle:user-a');
  });

  it('fails open (allows) when Redis is disconnected', async () => {
    redisService.getIsConnected.mockReturnValue(false);

    const r = await storage.increment('k3', 60_000, 1, 60_000, 'default');

    expect(r.isBlocked).toBe(false);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('fails open (allows) when Redis throws', async () => {
    redisService.getClient.mockReturnValue({
      eval: jest.fn().mockRejectedValue(new Error('boom')),
    });

    const r = await storage.increment('k4', 60_000, 1, 60_000, 'default');

    expect(r.isBlocked).toBe(false);
  });
});
