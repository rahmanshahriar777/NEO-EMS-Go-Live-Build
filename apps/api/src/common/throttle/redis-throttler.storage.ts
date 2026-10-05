import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
// ThrottlerStorageRecord is not re-exported from the @nestjs/throttler
// package index (v6.5); import the type from its declaration file.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../../core/redis/redis.service';

/**
 * B8 — Redis-backed throttler storage (shared across API replicas).
 *
 * The default ThrottlerStorageService keeps counters in process memory, which
 * lets an attacker multiply their budget by the replica count. This storage
 * implements the @nestjs/throttler v6 `ThrottlerStorage` contract
 * (`increment`) with a single atomic Lua script per request:
 *
 *   KEYS[1] = `throttle:{key}`          (hit counter, PEXPIRE = ttl)
 *   KEYS[2] = `throttle:{key}:blocked`  (block marker, PEXPIRE = blockDuration)
 *
 * Semantics mirror the in-memory implementation: when hits exceed the limit a
 * block marker is set for blockDuration; while the marker exists the request
 * is reported blocked WITHOUT incrementing the counter; when the marker
 * expires the counter resumes.
 *
 * Fail-open: if Redis is unreachable the request is allowed (rate limiting is
 * a DoS control, not an authentication boundary) and a warning is logged.
 * Losing strictness during a Redis outage is preferable to a full API outage.
 */
const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  local ttlLeft = redis.call('PTTL', KEYS[1])
  if ttlLeft < 0 then ttlLeft = tonumber(ARGV[1]) end
  return {hits, ttlLeft, 1, blockTtl}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttlLeft = redis.call('PTTL', KEYS[1])
if ttlLeft < 0 then ttlLeft = tonumber(ARGV[1]) end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', tonumber(ARGV[3]))
  return {hits, ttlLeft, 1, tonumber(ARGV[3])}
end
return {hits, ttlLeft, 0, 0}
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // The guard already folds the throttler name into `key`
    // (sha256 of class-handler-name-tracker), so no per-name suffix needed.
    const client = this.redisService.getClient();

    if (!client || !this.redisService.getIsConnected()) {
      this.logger.warn(
        `Redis unavailable for throttle key '${key}': allowing request (fail-open)`,
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    try {
      const counterKey = `throttle:${key}`;
      const blockKey = `throttle:${key}:blocked`;
      const result = (await client.eval(
        INCREMENT_SCRIPT,
        2,
        counterKey,
        blockKey,
        String(Math.max(1, Math.round(ttl))),
        String(limit),
        String(Math.max(1, Math.round(blockDuration))),
      )) as [number, number, number, number];

      const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result.map(Number);
      return {
        totalHits,
        timeToExpire: Math.max(0, Math.ceil(timeToExpire / 1000)),
        isBlocked: isBlocked === 1,
        timeToBlockExpire: Math.max(0, Math.ceil(timeToBlockExpire / 1000)),
      };
    } catch (e) {
      this.logger.warn(`Redis throttle increment failed for '${key}': ${(e as Error).message} (fail-open)`);
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
