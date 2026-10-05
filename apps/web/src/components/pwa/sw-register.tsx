'use client';

import { useEffect } from 'react';

/**
 * Registers the NEO EMS service worker (offline shell, Phase 3 item 7).
 * Runs once on the client; registration failures are logged, never surfaced
 * as user-facing errors — the app works fully online without the worker.
 */
export function SwRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Skip in development: the worker's static-asset caching fights HMR.
    if (process.env.NODE_ENV === 'development') return;

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[pwa] service worker registration failed:', err);
      });
  }, []);

  return null;
}
