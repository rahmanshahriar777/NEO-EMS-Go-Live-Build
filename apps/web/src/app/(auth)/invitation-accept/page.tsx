'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Lock, Eye, EyeOff, RefreshCw, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { api } from '../../../lib/api-client';
import '../../../styles/login.css';

/**
 * Invitation accept (Phase 1 B2: invitation-based onboarding).
 *
 * Flow: HR creates an invitation → the invitee opens the emailed link with
 * `?token=…` → sets a password here → POST /auth/invitations/accept
 * creates the user, links the employee record, and the page signs them in.
 *
 * API contract (worker 1): POST /auth/invitations/accept { token, password }
 * → { user: { email, … }, message? }. A missing/expired token is surfaced
 * loudly; nothing is fabricated.
 */
export default function InvitationAcceptPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Password must be at least 12 characters (platform password policy).');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/invitations/accept', { token, password });
      setDone(true);
      // Give the reader a beat, then land on the sign-in page.
      setTimeout(() => router.push('/login'), 2500);
    } catch (err: any) {
      setError(
        err?.message ||
          'This invitation link is invalid or has expired. Ask your HR administrator for a new one.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-editorial-wrapper">
      <div className="login-container">
        <div className="login-header">
          <Link href="/" className="login-brand-link">
            <div className="login-brand-mark">N</div>
            <div className="login-brand-text">
              <div className="login-brand-name">Neoteric Digital</div>
              <div className="login-brand-sub">
                <span>Identity Gateway</span>
                <span className="login-brand-badge">EMS</span>
              </div>
            </div>
          </Link>
          <h1 className="login-title">Accept Your Invitation</h1>
          <p className="login-subtitle">
            Set a password to activate your NEO EMS account.
          </p>
        </div>

        <div className="login-card">
          {!token && (
            <div className="login-error-alert" role="alert">
              <span>
                No invitation token was provided. Open the link from your invitation
                email, or ask HR to resend it.
              </span>
            </div>
          )}

          {done ? (
            <div className="text-center space-y-3 py-4">
              <CheckCircle2 size={36} className="mx-auto text-emerald-600" />
              <p className="text-sm font-semibold text-slate-800">Account activated</p>
              <p className="text-xs text-slate-500">
                Your account is ready. Redirecting you to sign in…
              </p>
            </div>
          ) : (
            token && (
              <form onSubmit={handleSubmit}>
                {error && (
                  <div className="login-error-alert" role="alert">
                    <span>{error}</span>
                  </div>
                )}
                <div className="login-form-group">
                  <label htmlFor="invite-password" className="login-label">
                    New Password (min. 12 characters)
                  </label>
                  <div className="login-input-wrapper">
                    <Lock size={16} className="login-input-icon" aria-hidden="true" />
                    <input
                      id="invite-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={12}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Choose a strong password"
                      className="login-input"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="login-password-toggle"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div className="login-form-group">
                  <label htmlFor="invite-confirm" className="login-label">
                    Confirm Password
                  </label>
                  <div className="login-input-wrapper">
                    <Lock size={16} className="login-input-icon" aria-hidden="true" />
                    <input
                      id="invite-confirm"
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="Repeat the password"
                      className="login-input"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <button type="submit" disabled={loading || !token} className="login-btn-submit">
                  {loading ? (
                    <>
                      <RefreshCw size={15} className="animate-spin" />
                      <span>Activating…</span>
                    </>
                  ) : (
                    <span>Activate Account</span>
                  )}
                </button>
              </form>
            )
          )}
        </div>

        <div className="login-footer-telemetry">
          <ShieldCheck size={14} style={{ color: 'var(--login-positive)' }} />
          <span>Encrypted Sessions &bull; RBAC Protected</span>
        </div>

        <div className="login-footer-links">
          <Link href="/login">
            <span>Back to sign in</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
