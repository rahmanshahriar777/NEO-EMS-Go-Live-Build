/**
 * Safe `?next=` redirect resolution for the login flow (go-live hardening).
 *
 * The middleware redirects unauthenticated users to `/login?next=<path>`; the
 * login page must honour that path instead of hard-pushing `/dashboard`, but
 * only when the value is a same-origin in-app path. Accepting an attacker-
 * controlled absolute URL (e.g. `?next=https://evil.example/phish`) would be
 * an open redirect, so anything that is not a plain site-relative path falls
 * back to `/dashboard`.
 */

/** Fallback destination used when no safe `next` value is present. */
export const DEFAULT_POST_LOGIN_PATH = '/dashboard';

/**
 * Returns a safe in-app path for post-login navigation, or the default.
 *
 * A value is safe when it:
 * - is a non-empty string,
 * - starts with exactly one leading `/` (no `//evil.com` protocol-relative,
 *   no `\` backslash tricks — some browsers treat `\evil.com` as a host),
 * - contains no scheme (`://` or `:` before any `/`), and
 * - stays inside the app (does not start with `/api/` — those are API routes).
 */
export function resolveSafeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || next.length === 0) return DEFAULT_POST_LOGIN_PATH;
  const trimmed = next.trim();
  if (!trimmed.startsWith('/')) return DEFAULT_POST_LOGIN_PATH;
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return DEFAULT_POST_LOGIN_PATH;
  // Reject backslash anywhere: `\/\evil.com`-style bypasses on some browsers.
  if (trimmed.includes('\\')) return DEFAULT_POST_LOGIN_PATH;
  // Reject schemes and protocol-relative forms: `javascript:`, `https://…`.
  const beforeFirstSlash = trimmed.slice(1).split('/')[0];
  if (beforeFirstSlash.includes(':')) return DEFAULT_POST_LOGIN_PATH;
  // API routes are not login destinations.
  if (trimmed === '/api' || trimmed.startsWith('/api/')) return DEFAULT_POST_LOGIN_PATH;
  return trimmed;
}
