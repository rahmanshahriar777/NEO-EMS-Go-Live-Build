import type { Metadata, Viewport } from 'next';
import '../styles/globals.css';
import { AuthProvider } from '../context/auth-context';
import { ReactQueryProvider } from '../lib/query-provider';
import { SwRegister } from '../components/pwa/sw-register';

// Fonts are self-hosted (public/fonts, @font-face in styles/globals.css).
// No third-party font requests: the old Google Fonts <link> tags were removed
// (Phase 1 security hardening) so the page never depends on fonts.googleapis.com.

export const metadata: Metadata = {
  title: 'Neoteric Digital — EMS | Enterprise Management System',
  description:
    'Neoteric Digital enterprise Employee Management System with attendance, leaves, payroll, and performance management.',
  icons: {
    icon: '/logo.png',
    shortcut: '/favicon.ico',
    apple: '/logo.png',
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'NEO EMS',
  },
};

export const viewport: Viewport = {
  themeColor: '#2c5f4a',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Force dynamic rendering for every route (CSP nonce support).
 *
 * The middleware issues a per-request CSP nonce and Next 15 stamps it onto
 * the framework's inline scripts (flight data, bootstrap) — but only for
 * pages rendered per request. Statically prerendered HTML is baked at build
 * time and can never carry the fresh nonce, so a nonce-only `script-src`
 * would block its inline scripts and kill hydration. This app is an
 * authenticated enterprise portal (no anonymous CDN-cachable pages), so
 * per-request SSR is the correct trade-off. If a route is ever made static
 * again, re-verify with `next build` (route table must show ƒ, not ○) and
 * `next start` (curl: every inline <script> must carry a nonce matching the
 * response CSP header).
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="light">
      <body className="bg-white text-slate-900 antialiased selection:bg-primary-500 selection:text-white">
        {/* React Query (go-live Phase 3 item 7) sits outside AuthProvider so
            data hooks are available to every route, including the (auth) group. */}
        <ReactQueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </ReactQueryProvider>
        {/* Registers the offline service worker + web-push subscription (client only). */}
        <SwRegister />
      </body>
    </html>
  );
}
