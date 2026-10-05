/**
 * Request-ID propagation (Phase 1 observability).
 *
 * Contract:
 * - Every inbound HTTP request gets an `x-request-id` (incoming value is
 *   honoured when it looks like an ID; otherwise a UUID v4 is minted).
 * - The API attaches the request ID as `correlationId` on every BullMQ job
 *   it enqueues (see @ems/shared queues payloads) so worker logs join back
 *   to the originating request.
 * - The worker already logs structured JSON with `correlationId`
 *   (apps/worker/src/logger.ts) — no change needed there.
 *
 * Wiring (API owner): register `requestIdMiddleware` as a global Express
 * middleware in apps/api/src/main.ts BEFORE the Nest app handles the
 * request, or as a Nest middleware consumer in AppModule. Web owner: forward
 * the header through next.config rewrites (Next forwards unknown headers
 * by default on rewrites — no action needed).
 *
 * NOTE: uses `globalThis.crypto.randomUUID()` (not `node:crypto`) so this
 * module stays importable from browser bundles — apps/web imports the
 * @ems/shared barrel in client components.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

const MAX_INCOMING_ID_LENGTH = 128;

/** Basic sanity check so we never reflect attacker-controlled garbage. */
function looksLikeId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_INCOMING_ID_LENGTH &&
    /^[A-Za-z0-9_\-.:]+$/.test(value)
  );
}

/**
 * Resolve the request ID for an inbound request: reuse the caller's
 * `x-request-id` when sane, otherwise mint one.
 */
export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const incoming = headers[REQUEST_ID_HEADER] ?? headers['X-Request-ID'];
  const first = Array.isArray(incoming) ? incoming[0] : incoming;
  if (first && looksLikeId(first.trim())) {
    return first.trim();
  }
  // globalThis.crypto.randomUUID() works in Node ≥19 and all browsers;
  // deliberately not `node:crypto` so web client bundles can import this.
  return globalThis.crypto.randomUUID();
}

export interface RequestIdCarrier {
  id?: string;
}

/**
 * Framework-lean Express middleware. Attaches `req.id` and echoes the ID
 * back on the response so clients can correlate.
 */
export function requestIdMiddleware(
  req: { headers: Record<string, string | string[] | undefined> } & RequestIdCarrier,
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
): void {
  const requestId = resolveRequestId(req.headers);
  req.id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
