'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Lock,
  Mail,
  ArrowRight,
  ShieldCheck,
  Eye,
  EyeOff,
  RefreshCw,
  ArrowLeft
} from 'lucide-react';
import { useAuth } from '../../../context/auth-context';
import { resolveSafeNextPath } from '../../../lib/safe-next';
import { formatAppTime, timezoneLabel } from '../../../lib/date-utils';
import '../../../styles/login.css';

function LoginForm() {
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [localTime, setLocalTime] = useState(timezoneLabel());

  // Go-live cross-cutting fix: honour the middleware's ?next= destination
  // (validated as a same-origin path by resolveSafeNextPath — never an
  // attacker-controlled absolute URL) instead of hard-pushing /dashboard.
  const nextPath = resolveSafeNextPath(searchParams.get('next'));

  useEffect(() => {
    const updateTime = () => {
      setLocalTime(`${formatAppTime()} • ${timezoneLabel()}`);
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password, nextPath);
    } catch (err: any) {
      setError(err.message || 'Failed to authenticate. Please check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-editorial-wrapper">
      <div className="login-container">
        {/* Header with Logo */}
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

          <h1 className="login-title">Enterprise Portal Sign In</h1>
          <p className="login-subtitle">
            Secure, role-governed workforce management gateway.
          </p>

          <div style={{ marginTop: '10px' }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '3px 10px',
              borderRadius: '20px',
              background: 'var(--login-surface)',
              border: '1px solid var(--login-border)',
              fontFamily: 'var(--login-font-mono)',
              fontSize: '11px',
              color: 'var(--login-text-tertiary)'
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--login-positive)' }}></span>
              <span>{localTime}</span>
            </span>
          </div>
        </div>

        {/* Card */}
        <div className="login-card">
          {error && (
            <div className="login-error-alert" role="alert">
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="login-form-group">
              <label htmlFor="login-email" className="login-label">Official Work Email</label>
              <div className="login-input-wrapper">
                <Mail size={16} className="login-input-icon" aria-hidden="true" />
                <input
                  id="login-email"
                  name="email"
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

            <div className="login-form-group">
              <label htmlFor="login-password" className="login-label">Password</label>
              <div className="login-input-wrapper">
                <Lock size={16} className="login-input-icon" aria-hidden="true" />
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="login-input"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="login-password-toggle"
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="login-btn-submit"
            >
              {loading ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  <span>Verifying Credentials...</span>
                </>
              ) : (
                <>
                  <span>Authenticate & Enter Workspace</span>
                  <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Security watermark */}
        <div className="login-footer-telemetry">
          <ShieldCheck size={14} style={{ color: 'var(--login-positive)' }} />
          <span>Encrypted Sessions &bull; RBAC Protected</span>
        </div>

        <div className="login-footer-links">
          <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <ArrowLeft size={13} />
            <span>Return to Neoteric Digital Overview</span>
          </Link>
          <Link href="/reset-password" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span>Forgot your password?</span>
            <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Next 15 requires a <Suspense> boundary around useSearchParams() at build
 * time; the form itself carries the redirect logic.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="login-editorial-wrapper">
          <div className="login-container">
            <p className="login-subtitle">Loading sign in…</p>
          </div>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
