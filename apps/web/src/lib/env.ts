/**
 * Central environment configuration for the NEO EMS web frontend.
 *
 * Conventions:
 * - `NEXT_PUBLIC_API_BASE_URL` (default `/api/v1`): base URL of the API,
 *   including the version prefix. Set to `/api/v1` to use the same-origin
 *   Next.js rewrite (`/api/*` -> API) in front of the API server.
 *   The legacy `NEXT_PUBLIC_API_URL` is still honoured as a fallback.
 *   NOTE: In Next.js client bundles, `process.env.NEXT_PUBLIC_*` MUST be
 *   accessed statically (e.g. `process.env.NEXT_PUBLIC_VAR`), NEVER via dynamic
 *   indexing (`process.env[name]`), otherwise Webpack/Turbopack cannot inline them.
 * - `NEXT_PUBLIC_TIMEZONE` (default `Europe/London`): IANA timezone used for
 *   all displayed dates/times.
 * - `NEXT_PUBLIC_LOCALE` (default `en-GB`): locale for date/number formatting.
 * - `NEXT_PUBLIC_CURRENCY` (default `GBP`): ISO 4217 currency code used for
 *   all money formatting.
 */

function cleanUrl(val?: string): string | null {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, '') : null;
}

/** Base URL of the REST API, defaulting to `/api/v1` (same-origin rewrite). */
export function getApiBaseUrl(): string {
  const primary = cleanUrl(process.env.NEXT_PUBLIC_API_BASE_URL);
  if (primary) return primary;
  const legacy = cleanUrl(process.env.NEXT_PUBLIC_API_URL);
  if (legacy) return legacy;
  return '/api/v1';
}

/**
 * Base URL of the REST API. Falls back to `/api/v1` so the client always has
 * a valid API route.
 */
export function requireApiBaseUrl(): string {
  return getApiBaseUrl();
}

/** IANA timezone for displayed dates/times. Defaults to Europe/London. */
export const APP_TIMEZONE: string =
  (process.env.NEXT_PUBLIC_TIMEZONE && process.env.NEXT_PUBLIC_TIMEZONE.trim()) || 'Europe/London';

/** Locale for Intl formatting. Defaults to en-GB. */
export const APP_LOCALE: string =
  (process.env.NEXT_PUBLIC_LOCALE && process.env.NEXT_PUBLIC_LOCALE.trim()) || 'en-GB';

/** ISO 4217 currency code for money formatting. Defaults to GBP. */
export const APP_CURRENCY: string = (
  (process.env.NEXT_PUBLIC_CURRENCY && process.env.NEXT_PUBLIC_CURRENCY.trim()) || 'GBP'
).toUpperCase();

/**
 * Whether the public self-registration page is enabled (go-live Phase 1 item 8).
 *
 * Mirrors the API's `ALLOW_PUBLIC_REGISTRATION` flag (default `false` =
 * invitation-only).
 */
export function isPublicRegistrationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION === 'true';
}
