'use client';

import React, { useState, useEffect } from 'react';
import { MonitorSmartphone, LogOut, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useSessionsQuery, securityKeys } from '../../../../lib/queries';
import { useAuth } from '../../../../context/auth-context';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import '../../../../styles/security.css';

interface Session {
  id: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt?: string;
  lastActiveAt?: string;
  current?: boolean;
}

/**
 * Active sessions (Phase 2 item 8).
 *
 * API contract (worker 1):
 *   GET    /auth/sessions      → Session[]
 *   DELETE /auth/sessions/:id  → revoke one session (not the current one)
 *
 * Revoking the current session signs this browser out — the API confirms
 * and the client then drops local state via /auth/logout.
 */
export default function SessionsPage() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const { data: rawSessions, isPending: loading, error: queryError, refetch } = useSessionsQuery();
  const sessions: Session[] = rawSessions || [];
  const error = queryError ? (queryError as Error).message || 'Could not load active sessions.' : null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const revoke = async (session: Session) => {
    setActionError(null);
    if (session.current) {
      // The current session is ended via the shared honest-logout flow:
      // it retries transient failures and only navigates once the API has
      // confirmed the logout (or the session is already dead server-side).
      // On failure we surface the error and stay on this page — navigating
      // to /login would lie to the user while the refresh token may be live.
      try {
        await logout();
      } catch (err: any) {
        setActionError(err?.message || 'Sign out failed. You are still signed in — please try again.');
      }
      return;
    }
    if (!window.confirm('Revoke this session? That device will be signed out immediately.')) return;
    setRevoking(session.id);
    setNotice(null);
    try {
      await api.delete(`/auth/sessions/${session.id}`);
      await queryClient.invalidateQueries({ queryKey: securityKeys.sessions() });
      setNotice('Session revoked. That device has been signed out.');
    } catch (err: any) {
      setNotice(null);
      alert(err?.message || 'Could not revoke that session.');
    } finally {
      setRevoking(null);
    }
  };

  const shortAgent = (ua?: string) => {
    if (!ua) return 'Unknown device';
    if (/mobile|android|iphone|ipad/i.test(ua)) return 'Mobile device';
    const m = ua.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/);
    return m ? `${m[1]} browser` : 'Desktop browser';
  };

  return (
    <DashboardLayout title="Active Sessions">
      <div className="sec-page">
        <div className="sec-card">
          <h2>
            <MonitorSmartphone className="w-5 h-5 text-[#2c5f4a]" />
            Where you&apos;re signed in
          </h2>
          <p className="sec-desc">
            Every device or browser holding a live session for your account.
            Revoke anything you don&apos;t recognize — that device is signed out
            immediately.
          </p>

          {notice && <div className="sec-success mb-3" role="status">{notice}</div>}

          {actionError && (
            <div className="mb-3">
              <ErrorBanner resource="sign out" detail={actionError} />
            </div>
          )}

          {error && (
            <div className="mb-3">
              <ErrorBanner
                resource="active sessions"
                detail={error}
                onRetry={() => refetch()}
                retrying={loading}
              />
            </div>
          )}

          {loading ? (
            <SkeletonTable rows={4} columns={3} />
          ) : sessions.length === 0 && !error ? (
            <div className="sec-empty">No active sessions found.</div>
          ) : (
            <div>
              {sessions.map((s) => (
                <div key={s.id} className="sec-session-row">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      {shortAgent(s.userAgent)}
                      {s.current && (
                        <span className="sec-badge sec-badge-on">This device</span>
                      )}
                    </div>
                    <div className="sec-session-meta">
                      {s.ipAddress || 'IP unknown'}
                      {s.lastActiveAt && (
                        <> &bull; last active {new Date(s.lastActiveAt).toLocaleString()}</>
                      )}
                      {s.createdAt && (
                        <> &bull; since {new Date(s.createdAt).toLocaleString()}</>
                      )}
                    </div>
                  </div>
                  <button
                    className={`sec-btn ${s.current ? 'sec-btn-ghost' : 'sec-btn-danger'}`}
                    disabled={revoking === s.id}
                    onClick={() => revoke(s)}
                    title={s.current ? 'Sign out this device' : 'Revoke this session'}
                  >
                    <LogOut className="w-4 h-4" />
                    {revoking === s.id ? 'Revoking…' : s.current ? 'Sign out' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
