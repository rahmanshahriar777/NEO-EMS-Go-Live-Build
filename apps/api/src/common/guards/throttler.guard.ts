import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * B8 — proxy-aware throttler keyed by user id + IP.
 *
 * Default ThrottlerGuard tracks by `req.ip` only, which lets one authenticated
 * user burn the shared budget of everyone behind the same NAT/proxy egress.
 * After JwtAuthGuard has run, `req.user.sub` is populated, so authenticated
 * requests are keyed `userId:ip` and anonymous requests (login, refresh,
 * public endpoints) fall back to `ip` alone.
 *
 * NOTE on ordering: this guard is registered AFTER JwtAuthGuard in AppModule
 * so `req.user` is available. The trade-off (unauthenticated floods reach
 * JwtAuthGuard first) is accepted because the strict per-route @Throttle
 * overrides on the auth endpoints are IP-keyed anyway.
 *
 * NOTE on proxies: `req.ip` is only trustworthy when Express trusts the
 * reverse proxy — main.ts must call
 *   app.set('trust proxy', configService.get<number>('security.trustProxyHops', 1))
 * (TRUST_PROXY_HOPS, default 1). Without it, X-Forwarded-For is ignored and
 * every client shares the proxy's IP.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = (req.ip as string | undefined) || 'unknown';
    const userId = req.user?.sub as string | undefined;
    return userId ? `${userId}:${ip}` : ip;
  }
}
