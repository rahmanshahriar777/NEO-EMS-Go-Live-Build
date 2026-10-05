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
