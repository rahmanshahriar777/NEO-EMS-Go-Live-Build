'use client';

import React, { useState, useEffect } from 'react';
import { ShieldCheck, Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api, ApiError } from '../../../../lib/api-client';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import '../../../../styles/security.css';

interface MfaStatus {
  enabled: boolean;
  hasRecoveryCodes?: boolean;
}

/**
 * MFA setup (Phase 2 item 8: TOTP).
 *
 * API contract (worker 1):
 *   GET  /mfa/status            → { enabled: boolean }
 *   POST /mfa/totp/setup        → { otpauthUrl: string, secret: string }
 *   POST /mfa/totp/verify       → { token } → { recoveryCodes: string[] }
 *   POST /mfa/totp/disable      → { password? }
 *
 * If any of these endpoints are missing (404), the page says so loudly —
 * MFA state is never guessed from local state.
 */
export default function MfaSetupPage() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [setup, setSetup] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [token, setToken] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [codesSaved, setCodesSaved] = useState(false);

  const [disablePassword, setDisablePassword] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const res = await api.get<MfaStatus>('/mfa/status');
      setStatus(res);
    } catch (err: any) {
      setStatus(null);
      setStatusError(
        err?.message ||
          'Could not load MFA status. The MFA API may not be deployed yet.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const beginSetup = async () => {
    setSetupBusy(true);
    setError(null);
    try {
      const res = await api.post<{ otpauthUrl: string; secret: string }>('/mfa/totp/setup', {});
      if (!res?.secret) throw new ApiError('Unexpected MFA setup response from the API.', 0);
      setSetup(res);
    } catch (err: any) {
      setError(err?.message || 'Could not start MFA setup.');
    } finally {
      setSetupBusy(false);
    }
  };

  const verifyToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyBusy(true);
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/mfa/totp/verify', { token });
      setRecoveryCodes(res?.recoveryCodes || []);
      setStatus({ enabled: true });
    } catch (err: any) {
      setError(err?.message || 'That code was not accepted. Check your authenticator app clock and try again.');
    } finally {
      setVerifyBusy(false);
    }
  };

  const disableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setDisableBusy(true);
    setError(null);
    try {
      await api.post('/mfa/totp/disable', { password: disablePassword || undefined });
      setStatus({ enabled: false });
      setSetup(null);
      setRecoveryCodes(null);
      setShowDisable(false);
      setDisablePassword('');
    } catch (err: any) {
      setError(err?.message || 'Could not disable MFA.');
    } finally {
      setDisableBusy(false);
    }
  };

  const copySecret = async () => {
    if (!setup?.secret) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard — select the secret manually.');
    }
  };

  return (
    <DashboardLayout title="Two-Factor Authentication">
      <div className="sec-page">
        <div className="sec-card">
          <h2>
            <ShieldCheck className="w-5 h-5 text-[#2c5f4a]" />
            Authenticator App (TOTP)
            <span className={`sec-badge ${status?.enabled ? 'sec-badge-on' : 'sec-badge-off'}`}>
              {loading ? '…' : status?.enabled ? 'Enabled' : 'Disabled'}
            </span>
          </h2>
          <p className="sec-desc">
            Time-based one-time codes from an authenticator app (Google Authenticator,
            Authy, 1Password…). Recovery codes are shown once at setup — store them
            somewhere safe.
          </p>

          {statusError && (
            <ErrorBanner
              resource="MFA status"
              detail={statusError}
              onRetry={fetchStatus}
              retrying={loading}
            />
          )}

          {!statusError && !loading && !status?.enabled && !setup && (
            <button className="sec-btn sec-btn-primary" onClick={beginSetup} disabled={setupBusy}>
              {setupBusy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              {setupBusy ? 'Starting…' : 'Set up authenticator app'}
            </button>
          )}

          {!statusError && !status?.enabled && setup && !recoveryCodes && (
            <div className="space-y-4 mt-2">
              {error && <div className="sec-error" role="alert">{error}</div>}
              <ol className="sec-steps">
                <li>
                  Open your authenticator app and add an account by entering the
                  setup key below manually (or scanning the otpauth URL if your app
                  supports importing it).
                </li>
                <li>
                  Enter the 6-digit code your app shows to confirm the pairing.
                </li>
              </ol>
              <div className="sec-secret-box">
                <span>{setup.secret}</span>
                <button
                  type="button"
                  onClick={copySecret}
                  className="sec-btn sec-btn-ghost"
                  style={{ padding: '6px 10px' }}
                  title="Copy setup key"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              {setup.otpauthUrl && (
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer font-medium text-slate-600">
                    Advanced: otpauth URL
                  </summary>
                  <code className="block mt-2 break-all bg-[#faf9f7] border border-[#e2dfda] rounded-lg p-2 font-mono text-[11px]">
                    {setup.otpauthUrl}
                  </code>
                </details>
              )}
              <form onSubmit={verifyToken} className="flex gap-2 max-w-sm">
                <input
                  className="sec-input"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={token}
                  onChange={(e) => setToken(e.target.value.replace(/\D/g, ''))}
                  aria-label="6-digit authenticator code"
                  required
                />
                <button type="submit" className="sec-btn sec-btn-primary" disabled={verifyBusy}>
                  {verifyBusy ? 'Verifying…' : 'Verify & enable'}
                </button>
              </form>
            </div>
          )}

          {recoveryCodes && (
            <div className="mt-2">
              <div className="sec-success" role="status">
                Authenticator enabled. Save these recovery codes now — each works
                once if you lose access to your authenticator app.
              </div>
              <div className="sec-recovery-grid">
                {recoveryCodes.map((code) => (
                  <div key={code} className="sec-recovery-code">{code}</div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={codesSaved}
                  onChange={(e) => setCodesSaved(e.target.checked)}
                />
                I have stored my recovery codes securely
              </label>
              <button
                className="sec-btn sec-btn-primary mt-3"
                disabled={!codesSaved}
                onClick={() => {
                  setRecoveryCodes(null);
                  setSetup(null);
                  setToken('');
                }}
              >
                Done
              </button>
            </div>
          )}

          {!loading && status?.enabled && (
            <div className="mt-2 space-y-3">
              {error && <div className="sec-error" role="alert">{error}</div>}
              {!showDisable ? (
                <button className="sec-btn sec-btn-danger" onClick={() => setShowDisable(true)}>
                  <AlertTriangle className="w-4 h-4" />
                  Disable two-factor authentication
                </button>
              ) : (
                <form onSubmit={disableMfa} className="flex flex-col sm:flex-row gap-2 max-w-md">
                  <input
                    type="password"
                    className="sec-input"
                    placeholder="Confirm with your password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="sec-btn sec-btn-danger" disabled={disableBusy}>
                      {disableBusy ? 'Disabling…' : 'Confirm disable'}
                    </button>
                    <button
                      type="button"
                      className="sec-btn sec-btn-ghost"
                      onClick={() => setShowDisable(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
