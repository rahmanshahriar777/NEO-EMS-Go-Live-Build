'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, KeyRound, RefreshCw, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../context/auth-context';
import '../../../styles/login.css';

/**
 * Second-factor step (Phase 2 MFA).
 *
 * Reached from the login page when POST /auth/login answers
 * `{ mfaRequired: true, challengeToken }` — the password passed but no
 * session was issued yet. The user enters the 6-digit TOTP code from their
 * authenticator app, or falls back to one of their one-time recovery codes;
 * both are accepted by the same field.
 *
 * API contract: POST /mfa/challenge { challengeToken, code } → the API sets
 * the httpOnly session cookies and returns { user }. The challenge token is
 * short-lived and single-use; completing it signs the user in.
 */
export default function MfaChallengePage() {
  const { mfaChallengeToken, completeMfaChallenge, cancelMfaChallenge, isLoading } = useAuth();
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (!useRecoveryCode && !/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    if (useRecoveryCode && trimmed.length === 0) {
      setError('Enter one of your recovery codes.');
      return;
    }
    setSubmitting(true);
    try {
      await completeMfaChallenge(trimmed);
      // completeMfaChallenge signs the user in and navigates on success.
    } catch (err: any) {
      setError(
        err?.message ||
          'That code was not accepted. Check your authenticator app and try again.',
      );
    } finally {
      setSubmitting(false);
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
          <h1 className="login-title">Two-Factor Verification</h1>
          <p className="login-subtitle">
            Your password was accepted. Enter the code from your authenticator
            app to finish signing in.
          </p>
        </div>

        <div className="login-card">
          {!mfaChallengeToken ? (
            <div role="alert">
              <div className="login-error-alert">
                <span>
                  No second-factor challenge is in progress — this page is only
                  reached after entering your password.
                </span>
              </div>
              <Link href="/login" className="login-btn-submit" style={{ textDecoration: 'none', display: 'flex', justifyContent: 'center' }}>
                <span>Back to sign in</span>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && (
                <div className="login-error-alert" role="alert">
                  <span>{error}</span>
                </div>
              )}
              <div className="login-form-group">
                <label htmlFor="mfa-code" className="login-label">
                  {useRecoveryCode ? 'Recovery code' : 'Authenticator code (6 digits)'}
                </label>
                <div className="login-input-wrapper">
                  <KeyRound size={16} className="login-input-icon" aria-hidden="true" />
                  <input
                    id="mfa-code"
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={useRecoveryCode ? 'Paste a recovery code' : '123456'}
                    className="login-input"
                    autoComplete="one-time-code"
                    inputMode={useRecoveryCode ? 'text' : 'numeric'}
                    maxLength={useRecoveryCode ? 64 : 6}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setUseRecoveryCode(!useRecoveryCode);
                  setCode('');
                  setError(null);
                }}
                className="login-link-button"
                style={{ marginBottom: '12px' }}
              >
                {useRecoveryCode
                  ? 'Use my authenticator app instead'
                  : "I don't have my authenticator — use a recovery code"}
              </button>
              <button type="submit" disabled={submitting || isLoading} className="login-btn-submit">
                {submitting ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>Verifying…</span>
                  </>
                ) : (
                  <span>Verify & Sign In</span>
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
          <button
            type="button"
            onClick={cancelMfaChallenge}
            className="login-link-button"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
          >
            <ArrowLeft size={13} />
            <span>Cancel and return to sign in</span>
          </button>
        </div>
      </div>
    </div>
  );
}
