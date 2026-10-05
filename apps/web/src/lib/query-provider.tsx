'use client';

import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Single shared React Query client for the web app.
 *
 * Library choice (go-live hardening, Phase 3 item 7):
 * - @tanstack/react-query is the smallest dependable pick for server-state
 *   management here. It is headless (no UI opinions, fits the bespoke CSS
 *   design), actively maintained, supports React 19, and is the de-facto
 *   standard — SWR is the main alternative but its cache/mutation model is
 *   thinner for the payroll/leave approval flows we will migrate later.
 * - react-hook-form (uncontrolled inputs, tiny re-render surface) was chosen
 *   over Formik (heavier, more re-renders) and over hand-rolled state for the
 *   leave/employee forms, for the same "smallest dependable" reason.
 *
 * Defaults are conservative for an HR system of record: data stays fresh for
 * 30s (avoids refetch storms on tab focus across 26 routes), a single retry
 * on failure (the api-client already retries 429/5xx itself), and mutations
 * never retry by default (double-submitting a leave request or payroll action
 * must be an explicit choice, never an accident).
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        // The API is the source of truth; refetching on window focus keeps
        // approval queues honest without the user hitting refresh.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Provides the React Query client to the whole app. Lazily created per
 * browser session so server components never share client state.
 */
export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
