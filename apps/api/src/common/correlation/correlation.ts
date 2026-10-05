import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * Request-scoped correlation ID (go-live hardening, Phase 3 item 10).
 *
 * The inbound `x-request-id` (honoured when sane, minted otherwise by the
 * shared `requestIdMiddleware`) is stored in an AsyncLocalStorage for the
 * lifetime of the request. Enqueue points read it via `getCorrelationId()`
 * instead of minting fresh UUIDs, so BullMQ job payloads join back to the
 * originating HTTP request in the worker's structured logs.
 *
 * Wiring: `correlationMiddleware` (below) must run AFTER `requestIdMiddleware`
 * in main.ts:
 *
 *   app.use(requestIdMiddleware);      // sets req.id
 *   app.use(correlationMiddleware);    // enters the ALS context
 *
 * Code that runs outside a request (crons, startup) simply sees `undefined`
 * from `getCorrelationId()` and falls back to minting a UUID at the call
 * site — the same as before.
 */

export interface CorrelationContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Run `fn` with `correlationId` as the ambient request correlation. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The ambient correlation ID for this request, or undefined outside one. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Express middleware: enters the ALS context using `req.id` (set by the
 * shared `requestIdMiddleware`). Mount AFTER `requestIdMiddleware`; if
 * `req.id` is absent (mis-ordered wiring) a UUID is minted so downstream
 * code never sees an undefined correlation.
 */
export function correlationMiddleware(req: any, _res: any, next: () => void): void {
  const id =
    typeof req?.id === 'string' && req.id.length > 0 ? req.id : randomUUID();
  runWithCorrelationId(id, next);
}
