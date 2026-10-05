/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // B6: standalone output is required by apps/web/Dockerfile — the runner
  // stage executes .next/standalone/server.js directly.
  output: 'standalone',
  transpilePackages: ['@ems/shared'],
  // Go-live Phase 1 item 8: the web /register page must mirror the API's
  // ALLOW_PUBLIC_REGISTRATION flag. NEXT_PUBLIC_ vars are inlined at build
  // time, so map the API-named var into the web one here — operators can set
  // a single ALLOW_PUBLIC_REGISTRATION knob for the whole deployment, or set
  // NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION directly on the web build.
  env: {
    NEXT_PUBLIC_API_BASE_URL:
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      '/api/v1',
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      '/api/v1',
    NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION:
      process.env.NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION ??
      process.env.ALLOW_PUBLIC_REGISTRATION ??
      'false',
  },
  // Build gates (F29): type and lint errors fail the build in production.
  // Never re-enable ignoreDuringBuilds / ignoreBuildErrors.
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: process.env.API_INTERNAL_URL || 'http://localhost:4000/api/:path*',
      },
    ];
  },
  async headers() {
    // NOTE: Content-Security-Policy and Permissions-Policy are owned by
    // middleware.ts (per-request nonce + per-route feature policy). They are
    // deliberately NOT duplicated here — two CSP headers would both be
    // enforced by the browser, and the static one could not carry the nonce.
    return [
      {
        source: '/:path*',
        headers: [
          // HSTS: force HTTPS for a year (only effective over HTTPS, harmless otherwise).
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
