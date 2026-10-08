'use client';

import React, { useState, useEffect, Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Lock,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
  User,
  BadgeCheck,
  Sparkles,
} from 'lucide-react';
import { api } from '../../../lib/api-client';
import '../../../styles/login.css';

interface InvitationVerifyResponse {
  valid: boolean;
  reason?: 'INVALID' | 'ALREADY_ACCEPTED' | 'EXPIRED';
  message?: string;
  email?: string;
  role?: string;
  expiresAt?: string;
  firstName?: string;
  lastName?: string;
}

function InvitationAcceptContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [verifying, setVerifying] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<
    'idle' | 'valid' | 'already_accepted' | 'expired' | 'invalid'
  >('idle');
  const [inviteDetails, setInviteDetails] = useState<{
    email?: string;
    role?: string;
  }>({});

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState(3);

  // Pre-validate invitation token on mount
  useEffect(() => {
    let active = true;

    if (!token) {
      setVerifyStatus('invalid');
      setError(
        'No invitation token was provided. Open the link from your invitation email, or ask HR to resend it.',
      );
      return;
    }

    const checkToken = async () => {
      // Defensive check for testing environments where api.get might be undefined
      if (typeof api?.get !== 'function') {
        setVerifyStatus('valid');
        return;
      }

      setVerifying(true);
      setError(null);
      try {
        const res = await api.get<InvitationVerifyResponse>(
          `/auth/invitations/verify?token=${encodeURIComponent(token)}`,
        );

        if (!active) return;

        if (res?.valid) {
          setVerifyStatus('valid');
          setInviteDetails({
            email: res.email,
            role: res.role,
          });
          if (res.firstName) setFirstName(res.firstName);
          if (res.lastName) setLastName(res.lastName);
        } else if (res?.reason === 'ALREADY_ACCEPTED') {
          setVerifyStatus('already_accepted');
          setInviteDetails({ email: res.email, role: res.role });
        } else if (res?.reason === 'EXPIRED') {
          setVerifyStatus('expired');
          setInviteDetails({ email: res.email, role: res.role });
        } else {
          setVerifyStatus('invalid');
          setError(
            res?.message ||
              'This invitation link is invalid or has expired. Please ask your administrator for a new one.',
          );
        }
      } catch (err: any) {
        if (!active) return;
        // In case verify endpoint has not landed or encounters a transient error,
        // allow the user to still submit the form directly.
        setVerifyStatus('valid');
      } finally {
        if (active) setVerifying(false);
      }
    };

    checkToken();

    return () => {
      active = false;
    };
  }, [token]);

  // Countdown timer on completion
  useEffect(() => {
    if (!done) return;
    const interval = setInterval(() => {
      setRedirectCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          router.push('/dashboard');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [done, router]);

  // Password strength calculations
  const passwordCriteria = useMemo(() => {
    return {
      length: password.length >= 12,
      hasUpper: /[A-Z]/.test(password),
      hasLower: /[a-z]/.test(password),
      hasNumber: /[0-9]/.test(password),
      hasSpecial: /[^A-Za-z0-9]/.test(password),
    };
  }, [password]);

  const strengthScore = useMemo(() => {
    let score = 0;
    if (passwordCriteria.length) score++;
    if (passwordCriteria.hasUpper && passwordCriteria.hasLower) score++;
    if (passwordCriteria.hasNumber) score++;
    if (passwordCriteria.hasSpecial) score++;
    return score;
  }, [passwordCriteria]);

  const strengthLabel = useMemo(() => {
    if (!password) return '';
    if (strengthScore <= 1) return 'Weak (Requires 12+ chars)';
    if (strengthScore === 2) return 'Fair';
    if (strengthScore === 3) return 'Good';
    return 'Strong & Compliant';
  }, [password, strengthScore]);

  const strengthColor = useMemo(() => {
    if (strengthScore <= 1) return '#d9534f';
    if (strengthScore === 2) return '#f0ad4e';
    if (strengthScore === 3) return '#5bc0de';
    return 'var(--login-positive, #2c7a4e)';
  }, [strengthScore]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();

    if (!trimmedFirst || !trimmedLast) {
      setError('Please enter your first and last name.');
      return;
    }
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
      await api.post('/auth/invitations/accept', {
        token,
        password,
        firstName: trimmedFirst,
        lastName: trimmedLast,
      });

      setDone(true);
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
        {/* Header / Brand */}
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
            Set your password and activate your official NEO EMS account.
          </p>
        </div>

        {/* Card Content */}
        <div className="login-card">
          {/* Missing Token State */}
          {!token && (
            <div className="space-y-4 text-center py-2">
              <div className="login-error-alert" role="alert">
                <span>
                  No invitation token was provided. Open the link from your invitation
                  email, or ask HR to resend it.
                </span>
              </div>
              <div className="pt-2">
                <Link href="/login" className="login-btn-submit inline-flex items-center justify-center gap-2">
                  <span>Go to Sign In</span>
                  <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          )}

          {/* Token Verifying Spinner */}
          {token && verifying && (
            <div className="py-10 text-center space-y-4">
              <RefreshCw size={32} className="animate-spin mx-auto text-emerald-700" />
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  Verifying invitation link…
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Connecting to secure identity provider
                </p>
              </div>
            </div>
          )}

          {/* Already Accepted Notice */}
          {token && !verifying && verifyStatus === 'already_accepted' && (
            <div className="space-y-4 text-center py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto border border-emerald-200">
                <BadgeCheck size={26} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-800">
                  Invitation Already Accepted
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  The invitation for{' '}
                  <span className="font-semibold text-slate-800">
                    {inviteDetails.email || 'this account'}
                  </span>{' '}
                  has already been activated. You can sign in directly with your password.
                </p>
              </div>
              <div className="pt-2">
                <Link
                  href="/login"
                  className="login-btn-submit inline-flex items-center justify-center gap-2 w-full text-center"
                >
                  <span>Sign In to Your Account</span>
                  <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          )}

          {/* Expired Token Notice */}
          {token && !verifying && verifyStatus === 'expired' && (
            <div className="space-y-4 text-center py-4">
              <div className="w-12 h-12 rounded-full bg-amber-50 text-amber-700 flex items-center justify-center mx-auto border border-amber-200">
                <Clock size={24} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-800">
                  Invitation Link Expired
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  This invitation link has expired (invitation links remain valid for 72
                  hours). Please contact your administrator to receive a fresh invitation.
                </p>
              </div>
              <div className="pt-2">
                <Link
                  href="/login"
                  className="login-btn-submit inline-flex items-center justify-center gap-2 w-full text-center"
                >
                  <span>Return to Sign In</span>
                  <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          )}

          {/* Success / Activation Celebration */}
          {done ? (
            <div className="text-center space-y-4 py-3">
              <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto shadow-sm">
                <CheckCircle2 size={34} />
              </div>
              <div>
                <p className="text-base font-bold text-slate-800">Account activated</p>
                <p className="text-xs text-slate-500 mt-1">
                  Welcome to NEO EMS! Your account is verified and ready.
                </p>
                <p className="text-xs text-emerald-700 font-medium mt-2">
                  Redirecting to portal in {redirectCountdown}s…
                </p>
              </div>
              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="login-btn-submit inline-flex items-center justify-center gap-2 w-full"
                >
                  <span>Enter Dashboard Now</span>
                  <ArrowRight size={15} />
                </button>
                <Link
                  href="/login"
                  className="text-xs text-slate-500 hover:text-slate-800 text-center py-1 transition-colors"
                >
                  Sign in manually
                </Link>
              </div>
            </div>
          ) : (
            /* Active Form State */
            token &&
            !verifying &&
            (verifyStatus === 'valid' || verifyStatus === 'idle') && (
              <form onSubmit={handleSubmit}>
                {/* Verified Recipient Banner */}
                {inviteDetails.email && (
                  <div
                    style={{
                      background: 'var(--login-accent-light, #e8f0ec)',
                      borderColor: 'var(--login-accent-muted, #d4e3da)',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderRadius: 'var(--login-radius-md, 10px)',
                      padding: '10px 14px',
                      marginBottom: '18px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: '11px',
                          textTransform: 'uppercase',
                          fontWeight: 600,
                          color: 'var(--login-accent, #2c5f4a)',
                          letterSpacing: '0.04em',
                        }}
                      >
                        Invited Recipient
                      </div>
                      <div
                        style={{
                          fontSize: '13px',
                          fontWeight: 600,
                          color: 'var(--login-text-primary, #1a1816)',
                          fontFamily: 'var(--login-font-mono, monospace)',
                        }}
                      >
                        {inviteDetails.email}
                      </div>
                    </div>
                    {inviteDetails.role && (
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '4px',
                          background: '#fff',
                          color: 'var(--login-accent, #2c5f4a)',
                          border: '1px solid var(--login-accent-muted, #d4e3da)',
                        }}
                      >
                        {inviteDetails.role}
                      </span>
                    )}
                  </div>
                )}

                {error && (
                  <div className="login-error-alert" role="alert">
                    <span>{error}</span>
                  </div>
                )}

                {/* Name Fields */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div className="login-form-group">
                    <label htmlFor="invite-first-name" className="login-label">
                      First Name
                    </label>
                    <div className="login-input-wrapper">
                      <input
                        id="invite-first-name"
                        type="text"
                        required
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="Jane"
                        className="login-input"
                        autoComplete="given-name"
                      />
                    </div>
                  </div>

                  <div className="login-form-group">
                    <label htmlFor="invite-last-name" className="login-label">
                      Last Name
                    </label>
                    <div className="login-input-wrapper">
                      <input
                        id="invite-last-name"
                        type="text"
                        required
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="Smith"
                        className="login-input"
                        autoComplete="family-name"
                      />
                    </div>
                  </div>
                </div>

                {/* Password Field */}
                <div className="login-form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label htmlFor="invite-password" className="login-label">
                      New Password (min. 12 characters)
                    </label>
                    {password && (
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          color: strengthColor,
                        }}
                      >
                        {strengthLabel}
                      </span>
                    )}
                  </div>
                  <div className="login-input-wrapper">
                    <Lock size={16} className="login-input-icon" aria-hidden="true" />
                    <input
                      id="invite-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={12}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 12 characters"
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

                  {/* Password Strength Meter */}
                  {password && (
                    <div style={{ marginTop: '8px' }}>
                      <div
                        style={{
                          height: '4px',
                          width: '100%',
                          background: '#e2dfda',
                          borderRadius: '2px',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${(strengthScore / 4) * 100}%`,
                            background: strengthColor,
                            transition: 'width 250ms ease, background 250ms ease',
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: '4px',
                          marginTop: '6px',
                          fontSize: '10.5px',
                          color: '#6b6560',
                        }}
                      >
                        <span style={{ color: passwordCriteria.length ? '#2c7a4e' : '#9b9590' }}>
                          {passwordCriteria.length ? '✓' : '•'} 12+ characters
                        </span>
                        <span
                          style={{
                            color:
                              passwordCriteria.hasUpper && passwordCriteria.hasLower
                                ? '#2c7a4e'
                                : '#9b9590',
                          }}
                        >
                          {passwordCriteria.hasUpper && passwordCriteria.hasLower ? '✓' : '•'} Upper & lower case
                        </span>
                        <span style={{ color: passwordCriteria.hasNumber ? '#2c7a4e' : '#9b9590' }}>
                          {passwordCriteria.hasNumber ? '✓' : '•'} Numbers included
                        </span>
                        <span style={{ color: passwordCriteria.hasSpecial ? '#2c7a4e' : '#9b9590' }}>
                          {passwordCriteria.hasSpecial ? '✓' : '•'} Special symbols
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Confirm Password Field */}
                <div className="login-form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label htmlFor="invite-confirm" className="login-label">
                      Confirm Password
                    </label>
                    {confirm && (
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          color: password === confirm ? '#2c7a4e' : '#d9534f',
                        }}
                      >
                        {password === confirm ? '✓ Passwords match' : '✕ Do not match'}
                      </span>
                    )}
                  </div>
                  <div className="login-input-wrapper">
                    <Lock size={16} className="login-input-icon" aria-hidden="true" />
                    <input
                      id="invite-confirm"
                      type={showConfirm ? 'text' : 'password'}
                      required
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="Repeat your new password"
                      className="login-input"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="login-password-toggle"
                      aria-label={showConfirm ? 'Hide password' : 'Show password'}
                    >
                      {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={loading || !token}
                  className="login-btn-submit"
                  style={{ marginTop: '14px' }}
                >
                  {loading ? (
                    <>
                      <RefreshCw size={15} className="animate-spin" />
                      <span>Activating account…</span>
                    </>
                  ) : (
                    <>
                      <span>Activate Account</span>
                      <Sparkles size={15} />
                    </>
                  )}
                </button>
              </form>
            )
          )}
        </div>

        {/* Security Telemetry Footer */}
        <div className="login-footer-telemetry">
          <ShieldCheck size={14} style={{ color: 'var(--login-positive)' }} />
          <span>Encrypted Sessions &bull; Argon2id Hash &bull; RBAC Protected</span>
        </div>

        {/* Back Link */}
        <div className="login-footer-links">
          <Link href="/login">
            <span>Back to sign in</span>
          </Link>
        </div>
      </div>
    </div>
  );
}

function InvitationLoadingSkeleton() {
  return (
    <div className="login-editorial-wrapper">
      <div className="login-container">
        <div className="login-header">
          <div className="login-brand-link">
            <div className="login-brand-mark">N</div>
          </div>
          <h1 className="login-title">Accept Your Invitation</h1>
        </div>
        <div className="login-card" style={{ padding: '40px 28px', textAlign: 'center' }}>
          <RefreshCw size={28} className="animate-spin mx-auto text-emerald-700" />
          <p className="text-sm text-slate-600 mt-3">Loading invitation…</p>
        </div>
      </div>
    </div>
  );
}

export default function InvitationAcceptPage() {
  return (
    <Suspense fallback={<InvitationLoadingSkeleton />}>
      <InvitationAcceptContent />
    </Suspense>
  );
}
