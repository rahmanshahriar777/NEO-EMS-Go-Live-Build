'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Mail, RefreshCw, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { api } from '../../../lib/api-client';
import '../../../styles/login.css';

/**
 * Password-reset request (Phase 1 password hardening companion).
 *
 * API contract (worker 1): POST /auth/password-reset/request { email }.
 * The response never reveals whether the address exists — the UI always
 * shows the same neutral confirmation to avoid account enumeration.
 */
export default function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post('/auth/password-reset/request', { email });
      setSent(true);
    } catch (err: any) {
      // Transport-level failure only (the API itself always answers 200 to
      // avoid enumeration). Surface connectivity problems loudly.
      setError(err?.message || 'Could not reach the server. Please try again.');
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
          <h1 className="login-title">Reset Your Password</h1>
          <p className="login-subtitle">
            We&apos;ll email you a secure link to choose a new password.
          </p>
        </div>

        <div className="login-card">
          {sent ? (
            <div className="text-center space-y-3 py-4">
              <CheckCircle2 size={36} className="mx-auto text-emerald-600" />
              <p className="text-sm font-semibold text-slate-800">Check your inbox</p>
              <p className="text-xs text-slate-500">
                If an account exists for <strong>{email}</strong>, a reset link is on
                its way. The link expires after a short window.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && (
                <div className="login-error-alert" role="alert">
                  <span>{error}</span>
                </div>
              )}
              <div className="login-form-group">
                <label htmlFor="reset-email" className="login-label">
                  Official Work Email
                </label>
                <div className="login-input-wrapper">
                  <Mail size={16} className="login-input-icon" aria-hidden="true" />
                  <input
                    id="reset-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="login-input"
                    autoComplete="email"
                  />
                </div>
              </div>
              <button type="submit" disabled={loading} className="login-btn-submit">
                {loading ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>Sending…</span>
                  </>
                ) : (
                  <span>Send Reset Link</span>
                )}
              </button>
            </form>
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
