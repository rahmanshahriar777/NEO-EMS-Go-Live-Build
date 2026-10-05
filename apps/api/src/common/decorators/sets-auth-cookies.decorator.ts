import { SetMetadata } from '@nestjs/common';

export const SETS_AUTH_COOKIES_KEY = 'setsAuthCookies';

/**
 * Marks a route handler that SETS authentication cookies on success
 * (POST /auth/login, POST /auth/refresh, POST /mfa/challenge).
 *
 * Rationale (P0-5, login CSRF / session fixation): CsrfGuard skips @Public()
 * routes, but these three are public AND cookie-issuing — a forged
 * top-level cross-origin POST would fix the victim's browser to the
 * attacker's session. The guard therefore applies a strict
 * Origin/Referer check (absent or cross-origin is rejected) to marked
 * routes, unless the request carries an Authorization header (Bearer-token
 * API clients are not subject to ambient cookie submission).
 */
export const SetsAuthCookies = () => SetMetadata(SETS_AUTH_COOKIES_KEY, true);
