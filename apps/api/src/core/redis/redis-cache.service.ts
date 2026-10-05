import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * RedisCacheService — read-through cache for hot, low-cardinality reads
 * (go-live hardening, §5 performance).
 *
 * Cached today:
 * - `user:active:<userId>` — the isActive flag the JWT strategy checks on
 *   EVERY request (60s TTL). A stale entry can delay a deactivation by at
 *   most the TTL; deactivation also calls `invalidateUser()` from the user
 *   write paths (see note below).
 * - Reference data: departments, leave types, holidays (5-minute TTL).
 *
 * Failure mode is fail-OPEN for reads: any Redis error degrades to a cache
 * miss and the caller falls back to the database. The cache must never
 * cause an outage or lock users out.
 *
 * INVALIDATION (write paths): the modules that mutate this data
 * (employees/users for isActive; departments / leaves / calendar-holiday
 * writers for reference data) must call `invalidateUser(userId)` /
 * `invalidateReferenceData(kind)` after a successful write. Those call
 * sites live outside this service's owning worker scope — they are listed
 * explicitly so the coordinator can wire them:
 *   - user.isActive writes → employees.service / auth flows
 *   - departments CRUD   → departments.service
 *   - leave types CRUD   → leaves module (leave-type admin)
 *   - holidays CRUD      → calendar/holiday writers
 * Until wired, the short TTLs bound staleness (60s / 5 min).
 */

const KEY_PREFIX = 'ems:cache:';

export type ReferenceDataKind = 'departments' | 'leave-types' | 'holidays';

const REFERENCE_DATA_KEYS: Record<ReferenceDataKind, string> = {
  departments: `${KEY_PREFIX}ref:departments`,
  'leave-types': `${KEY_PREFIX}ref:leave-types`,
  holidays: `${KEY_PREFIX}ref:holidays`,
};

@Injectable()
export class RedisCacheService {
  private readonly logger = new Logger(RedisCacheService.name);

  constructor(private readonly redis: RedisService) {}

  // ------------------------------------------------------------------
  // Generic JSON helpers
  // ------------------------------------------------------------------

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(KEY_PREFIX + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(KEY_PREFIX + key, JSON.stringify(value), ttlSeconds);
    } catch (e: any) {
      // Fail-open: caching is best-effort.
      this.logger.warn(`cache set failed for ${key}: ${e.message}`);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }

  // ------------------------------------------------------------------
  // user-active flag (JWT strategy hot path)
  // ------------------------------------------------------------------

  private userActiveKey(userId: string): string {
    return `user:active:${userId}`;
  }

  /**
   * Returns the cached isActive flag, or null on miss / Redis error.
   * Null MUST be treated as "unknown — check the database".
   */
  async getUserActive(userId: string): Promise<boolean | null> {
    const cached = await this.getJson<{ active: boolean }>(this.userActiveKey(userId));
    return cached ? cached.active : null;
  }

  /**
   * Cache the isActive flag. Short TTL (default 60s) bounds how long a
   * deactivation can lag behind the database when invalidation is missed.
   */
  async setUserActive(userId: string, active: boolean, ttlSeconds = 60): Promise<void> {
    await this.setJson(this.userActiveKey(userId), { active }, ttlSeconds);
  }

  /** Call after any write to user.isActive (deactivate/reactivate/delete). */
  async invalidateUser(userId: string): Promise<void> {
    await this.del(this.userActiveKey(userId));
  }

  // ------------------------------------------------------------------
  // Reference data (departments, leave types, holidays)
  // ------------------------------------------------------------------

  /**
   * Read-through cache for reference lists. `loader` runs on miss and its
   * result is cached for `ttlSeconds` (default 5 minutes).
   */
  async getReferenceData<T>(
    kind: ReferenceDataKind,
    loader: () => Promise<T>,
    ttlSeconds = 300,
  ): Promise<T> {
    const key = REFERENCE_DATA_KEYS[kind];
    const raw = await this.redis.get(key);
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        // fall through to reload
      }
    }
    const fresh = await loader();
    try {
      await this.redis.set(key, JSON.stringify(fresh), ttlSeconds);
    } catch (e: any) {
      this.logger.warn(`reference-data cache set failed for ${kind}: ${e.message}`);
    }
    return fresh;
  }

  /**
   * Call after any write to the underlying reference table. With no `kind`,
   * invalidates all reference-data keys (safe, slightly broader).
   */
  async invalidateReferenceData(kind?: ReferenceDataKind): Promise<void> {
    const keys = kind ? [REFERENCE_DATA_KEYS[kind]] : Object.values(REFERENCE_DATA_KEYS);
    for (const key of keys) {
      await this.redis.del(key);
    }
  }
}
