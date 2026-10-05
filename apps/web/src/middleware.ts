import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Route protection + security headers for the EMS web app.
 *
 * AUTH: The API is the source of truth for session validity; this middleware
 * only checks for the PRESENCE of the `ems_at` httpOnly cookie (set by the API
 * on login/refresh) to decide whether to let a request through to a protected
 * route. An invalid/expired cookie still reaches the page, but the API
 * returns 401, the api-client rejects, and the user is bounced to /login.
 *
 * CSP: a fresh cryptographic nonce is generated per request and injected into
 * `script-src`. No 'unsafe-inline' and no 'unsafe-eval' on scripts — the app
 * ships zero inline <script> tags of its own (verified: no dangerouslySetInner
 * HTML, no <script> in components; the service worker registers from a client
 * component). `style-src` keeps 'unsafe-inline' because React inline style
 * props are used pervasively across the UI.
 *
 * NONCE PROPAGATION (Next 15): the App Router emits its own inline bootstrap
 * scripts (flight-data streams, preinit scripts). Next 15's app-render reads
 * the `Content-Security-Policy` *request* header, extracts the first
 * 'nonce-…' source from `script-src` (see
 * next/dist/server/app-render/get-script-nonce-from-header.js), and stamps
 * that nonce onto every framework-emitted inline script. The middleware
 * therefore sets the CSP value as a REQUEST header (in addition to the
 * response header that enforces the policy) — this is the documented
 * framework mechanism, not a workaround. Authored scripts can additionally
 * read the nonce from the `x-ems-csp-nonce` request header (Next
 * <Script nonce={…}>).
 *
 * LOCATION (critical): this file MUST live at src/middleware.ts — i.e. at the
 * same level as the `app/` directory ("inside src if applicable", per the
 * Next.js middleware convention). Next 15 detects middleware by scanning the
 * parent of the app dir; a middleware.ts at the project root is silently
 * IGNORED (empty middleware manifest, no headers, no redirects). It previously
 * sat at the project root and never ran.
 *
 * RENDERING MODE (critical): every route in this app is force-dynamic (see
 * `export const dynamic = 'force-dynamic'` in app/layout.tsx). Static
 * prerendering is incompatible with per-request nonces: prerendered HTML is
 * baked at build time, so the middleware's fresh nonce can never be stamped
 * into its inline flight scripts, and a nonce-only script-src would block
 * them (hydration dies — the login form would not submit). If a route is ever
 * made static again, re-verify with `next build` (route table must show ƒ, not
 * ○) and `next start` (curl the page: every inline <script> must carry
 * nonce="<value>" matching the response's Content-Security-Policy header, and
 * the nonce must differ between requests).
 */
const AUTH_COOKIE = 'ems_at';
const NONCE_HEADER = 'x-ems-csp-nonce';

// App routes that require a session (the (dashboard) route group's paths).
const PROTECTED_PATHS = [
  '/dashboard',
  '/admin',
  '/employees',
  '/attendance',
  '/leaves',
  '/payroll',
  '/performance',
  '/calendar',
  '/ai-assistant',
  '/organization',
  '/profile',
  '/rostering',
  '/documents',
  '/security',
];

// Public auth pages that an already-signed-in user should skip.
const AUTH_PAGES = ['/login', '/register', '/invitation-accept', '/reset-password', '/mfa-challenge'];

// Routes where the Web Speech API is used (ai-assistant voice input).
const MICROPHONE_PATHS = ['/ai-assistant'];
// Routes where location-checked clock-in uses geolocation.
const GEOLOCATION_PATHS = ['/attendance', '/dashboard'];

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Derives the API origin for `connect-src` (go-live Phase 2 item 10).
 *
 * The app may talk to the API through the same-origin `/api/*` rewrite
 * ('self' suffices) or directly to a cross-origin API origin
 * (`NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api/v1`). Without the
 * origin in `connect-src`, a cross-origin API deployment is blocked by the
 * CSP. Non-absolute or non-http(s) values yield `null` (fail closed to
 * `'self'`).
 */
function apiOriginForCsp(): string | null {
  const base = (
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  if (!base || base.startsWith('/')) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

const API_ORIGIN = apiOriginForCsp();

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const directives = [
    "default-src 'self'",
    // Nonce-based script allowlist; development Next.js needs 'unsafe-eval' for HMR/Fast Refresh.
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ''}`,
    // React inline style props require this; no inline <style> blocks are used.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Cross-origin API deployments need their origin listed here (see
    // apiOriginForCsp); same-origin deployments keep plain 'self'.
    `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isDev) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

function buildPermissionsPolicy(pathname: string): string {
  const microphone = matches(pathname, MICROPHONE_PATHS) ? 'microphone=(self)' : 'microphone=()';
  const geolocation = matches(pathname, GEOLOCATION_PATHS)
    ? 'geolocation=(self)'
    : 'geolocation=()';
  // Camera is unused anywhere in the app; everything else stays locked down.
  return [`camera=()`, microphone, geolocation].join(', ');
}

export function middleware(req: NextRequest) {
  const hasSessionCookie = Boolean(req.cookies.get(AUTH_COOKIE)?.value);
  const { pathname } = req.nextUrl;

  if (matches(pathname, PROTECTED_PATHS) && !hasSessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (matches(pathname, AUTH_PAGES) && hasSessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Per-request CSP nonce (Phase 1 security hardening).
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Buffer.from(nonceBytes).toString('base64');
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(req.headers);
  // Propagate the nonce to server components via a request header so any
  // future inline script we author can carry it (Next <Script nonce={...}>).
  requestHeaders.set(NONCE_HEADER, nonce);
  // Propagate the CSP value itself as a REQUEST header: Next 15's app-render
  // (getScriptNonceFromHeader) parses the first 'nonce-…' from script-src out
  // of the incoming request's Content-Security-Policy header and stamps it on
  // every inline script the framework emits (flight data, bootstrap,
  // preinit). Without this, a nonce-only script-src blocks hydration.
  requestHeaders.set('Content-Security-Policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // Enforcement: the response header is what the browser actually applies.
  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('Permissions-Policy', buildPermissionsPolicy(pathname));
  // Debug affordance: the active nonce is inspectable in devtools.
  res.headers.set(NONCE_HEADER, nonce);
  return res;
}

export const config = {
  matcher: [
    /*
     * Run on all app routes (security headers must cover every page).
     * Static build output and the service worker are excluded — they carry
     * no HTML and need no CSP of their own.
     */
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|fonts/|logo.png|logo.jpg).*)',
  ],
};
