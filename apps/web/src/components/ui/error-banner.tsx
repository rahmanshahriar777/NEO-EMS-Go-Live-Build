'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBannerProps {
  /** What failed to load, e.g. "employees". Rendered as "Couldn't load employees". */
  resource: string;
  /** Optional server-provided detail shown under the headline. */
  detail?: string | null;
  /** Retry handler. When omitted the retry button is hidden. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Loud, honest failure state shown instead of fabricated fallback data.
 * No page may render mock/demo data when the API is unreachable — it must
 * render this (or an equivalent inline error) instead.
 */
export const ErrorBanner: React.FC<ErrorBannerProps> = ({ resource, detail, onRetry, retrying }) => {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3.5"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-rose-700">
          Couldn&apos;t load {resource}.
        </p>
        {detail && (
          <p className="mt-0.5 break-words text-xs text-rose-600/90">{detail}</p>
        )}
        <p className="mt-1 text-xs text-slate-500">
          The data shown elsewhere on this page is not available right now. No placeholder data is displayed.
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
};
