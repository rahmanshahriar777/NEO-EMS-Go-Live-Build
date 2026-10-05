import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>('redis.host', 'localhost');
    const port = this.configService.get<number>('redis.port', 6379);
    const password = this.configService.get<string>('redis.password');

    try {
      this.client = new Redis({
        host,
        port,
        password: password || undefined,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log(`Redis connected on ${host}:${port}`);
      });

      this.client.on('close', () => {
        this.isConnected = false;
        this.logger.error(`[ALERT] Redis connection closed on ${host}:${port}`);
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.error(`[ALERT] Redis connection error on ${host}:${port}: ${err.message}`);
      });

      // Try connecting lazily
      this.client.connect().catch((err) => {
        this.logger.warn(`Redis initial connect deferred: ${err.message}`);
      });
    } catch (e: any) {
      this.logger.error(`[ALERT] Failed to initialize Redis client: ${e.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (e) {
      this.logger.warn(`Redis set error for ${key}: ${e.message}`);
    }
  }

  /**
   * Atomically set a key only if it does not already exist (SET ... NX EX).
   *
   * Used for single-use / replay guards (MFA challenge jti consumption, TOTP
   * time-step claims): returns true when this caller won the claim, false
   * when the key already existed (replay). Two concurrent claimants: exactly
   * one wins.
   *
   * Fail-open when Redis is unreachable (returns true), matching the
   * throttler storage convention — but logs a LOUD WARN so operators can
   * see replay-guard degradation in the structured logs during an outage.
   * Callers (MFA, TOTP) must treat a fail-open as a security degradation
   * event and ensure their surrounding rate-limits still apply.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const client = this.getClient();
    const failClosed = this.configService.get<string>('REDIS_REPLAY_FAIL_CLOSED') === 'true';
    if (!client || !this.isConnected) {
      if (failClosed) {
        this.logger.error(
          `[ALERT] setIfAbsent FAIL-CLOSED for key '${key}': Redis unreachable — rejecting replay guard claim`,
        );
        return false;
      }
      // Documented accepted risk when REDIS_REPLAY_FAIL_CLOSED is false (or unset)
      this.logger.warn(
        `[ALERT] setIfAbsent FAIL-OPEN for key '${key}': Redis unreachable — replay guard is DEGRADED (documented acceptance)`,
      );
      return true;
    }
    try {
      const res = await client.set(key, value, 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (e) {
      if (failClosed) {
        this.logger.error(
          `[ALERT] setIfAbsent FAIL-CLOSED for key '${key}': ${(e as Error).message} — rejecting replay guard claim`,
        );
        return false;
      }
      this.logger.warn(
        `[ALERT] setIfAbsent FAIL-OPEN for key '${key}': ${(e as Error).message} — replay guard is DEGRADED (documented acceptance)`,
      );
      return true;
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.del(key);
    } catch (e) {
      this.logger.warn(`Redis del error for ${key}: ${e.message}`);
    }
  }
}
