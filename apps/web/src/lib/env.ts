/**
 * Central environment configuration for the NEO EMS web frontend.
 *
 * Conventions:
 * - `NEXT_PUBLIC_API_BASE_URL` (required): base URL of the API, including the
 *   version prefix, e.g. `https://api.example.com/api/v1`. Set it to `/api/v1`
 *   to use the same-origin Next.js rewrite (`/api/*` -> API) in front of the
 *   API server.
 *   The legacy `NEXT_PUBLIC_API_URL` is still honoured as a fallback so the
 *   existing docker entrypoint keeps working, but it is deprecated.
 * - `NEXT_PUBLIC_TIMEZONE` (default `Europe/London`): IANA timezone used for
 *   all displayed dates/times. No timezone is hardcoded anywhere else.
 * - `NEXT_PUBLIC_LOCALE` (default `en-GB`): locale for date/number formatting.
 * - `NEXT_PUBLIC_CURRENCY` (default `GBP`): ISO 4217 currency code used for
 *   all money formatting.
 */

function readPublicEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Base URL of the REST API, or `null` when it is not configured. */
export function getApiBaseUrl(): string | null {
  const primary = readPublicEnv('NEXT_PUBLIC_API_BASE_URL');
  if (primary) return primary.replace(/\/+$/, '');
  const legacy = readPublicEnv('NEXT_PUBLIC_API_URL');
  if (legacy) return legacy.replace(/\/+$/, '');
  return null;
}

/**
 * Base URL of the REST API, throwing a loud, actionable error when it is not
 * configured. Call this at request time (never at module scope) so the
 * failure surfaces exactly where the misconfiguration bites.
 */
export function requireApiBaseUrl(): string {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'API not configured: set NEXT_PUBLIC_API_BASE_URL (e.g. "/api/v1" for the ' +
        'same-origin rewrite, or "https://api.example.com/api/v1"). Requests cannot be sent without it.',
    );
  }
  return baseUrl;
}

/** IANA timezone for displayed dates/times. Defaults to Europe/London. */
export const APP_TIMEZONE: string = readPublicEnv('NEXT_PUBLIC_TIMEZONE') || 'Europe/London';

/** Locale for Intl formatting. Defaults to en-GB. */
export const APP_LOCALE: string = readPublicEnv('NEXT_PUBLIC_LOCALE') || 'en-GB';

/** ISO 4217 currency code for money formatting. Defaults to GBP. */
export const APP_CURRENCY: string = (readPublicEnv('NEXT_PUBLIC_CURRENCY') || 'GBP').toUpperCase();

/**
 * Whether the public self-registration page is enabled (go-live Phase 1 item 8).
 *
 * Mirrors the API's `ALLOW_PUBLIC_REGISTRATION` flag (default `false` =
 * invitation-only). Ops should set both `ALLOW_PUBLIC_REGISTRATION` on the API
 * and `NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION` on the web build; next.config.mjs
 * additionally maps the API-named var into the NEXT_PUBLIC_ one so a single
 * deployment knob works. The API 403s `/auth/register` regardless — this only
 * controls what the UI shows.
 */
export function isPublicRegistrationEnabled(): boolean {
  return readPublicEnv('NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION') === 'true';
}
