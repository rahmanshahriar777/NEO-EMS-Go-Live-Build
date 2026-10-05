import { DashboardLayout } from '../../components/layout/dashboard-layout';
import Link from 'next/link';

export const metadata = {
  title: 'Offline — NEO EMS',
};

/**
 * Offline fallback page. Shown by the service worker when a navigation fails
 * with no network. Deliberately contains no data — the app never renders
 * cached/fabricated records in place of live API data.
 */
export default function OfflinePage() {
  return (
    <DashboardLayout title="Offline">
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-3xl">
          📡
        </div>
        <h1 className="text-xl font-bold text-slate-900">You are offline</h1>
        <p className="max-w-md text-sm text-slate-500">
          NEO EMS needs a network connection to load live workforce data. Nothing on
          this page is cached — your data stays accurate instead of stale.
        </p>
        <Link
          href="/dashboard"
          className="rounded-xl bg-[#2c5f4a] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#24493a]"
        >
          Retry connection
        </Link>
      </div>
    </DashboardLayout>
  );
}
