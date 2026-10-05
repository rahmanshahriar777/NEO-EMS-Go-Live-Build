'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle, Loader2, MailCheck } from 'lucide-react';
import { api } from '../../../lib/api-client';
import { Logo } from '../../../components/ui/logo';

/**
 * Email verification landing page.
 * The registration email links here as `/verify-email?token=<token>`.
 * Calls POST /auth/verify-email exactly once per token.
 */
export default function VerifyEmailPage() {
  // Next 15 requires a <Suspense> boundary around useSearchParams() at build time.
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-sm text-slate-400">Loading…</p></div>}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState<string>('Verifying your email…');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setMessage('No verification token was provided. Please use the link from your registration email.');
      return;
    }
    let cancelled = false;
    api
      .post<{ message?: string }>('/auth/verify-email', { token })
      .then((res) => {
        if (cancelled) return;
        setStatus('success');
        setMessage(res?.message || 'Email verified successfully. You can now log in.');
      })
      .catch((err: any) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err?.message || 'Verification failed. The link may have expired — try registering again or request a new link.');
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-white flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3 flex flex-col items-center">
          <Link href="/" className="inline-block hover:opacity-90 transition mb-2">
            <Logo size="xl" priority />
          </Link>
          <h2 className="text-2xl font-bold text-slate-100 tracking-tight">Email Verification</h2>
        </div>

        <div className="glass-card p-8 rounded-2xl border border-white/10 shadow-2xl text-center space-y-4">
          {status === 'pending' && (
            <>
              <Loader2 className="w-10 h-10 text-indigo-400 animate-spin mx-auto" />
              <p className="text-sm text-slate-300">{message}</p>
            </>
          )}
          {status === 'success' && (
            <>
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
              <p className="text-sm text-slate-200 font-medium">{message}</p>
              <Link
                href="/login"
                className="inline-block px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition"
              >
                Go to sign in
              </Link>
            </>
          )}
          {status === 'error' && (
            <>
              <XCircle className="w-10 h-10 text-rose-400 mx-auto" />
              <p className="text-sm text-slate-300">{message}</p>
              <div className="flex items-center justify-center gap-3">
                <Link href="/login" className="text-sm text-indigo-400 hover:underline">
                  Sign in
                </Link>
                <span className="text-slate-600">·</span>
                <Link href="/register" className="text-sm text-indigo-400 hover:underline">
                  Register again
                </Link>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-slate-500 flex items-center justify-center gap-1.5">
          <MailCheck className="w-3.5 h-3.5" /> Didn&apos;t get the email? Check spam, or register again to resend.
        </p>
      </div>
    </div>
  );
}
