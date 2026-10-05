'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Sparkles, Lock, Mail, User, ArrowRight } from 'lucide-react';
import { useAuth } from '../../../context/auth-context';
import { isPublicRegistrationEnabled } from '../../../lib/env';
import { Logo } from '../../../components/ui/logo';

export default function RegisterPage() {
  // Go-live Phase 1 item 8: the API already 403s POST /auth/register unless
  // ALLOW_PUBLIC_REGISTRATION=true. The UI side of the gate: when public
  // registration is disabled (the default), show the invitation-only notice
  // instead of a sign-up form that could never succeed.
  const publicRegistration = isPublicRegistrationEnabled();
  const { register } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Registration does NOT sign the user in: the API requires email
      // verification first. Show the "check your inbox" message instead.
      const message = await register(email, password, firstName, lastName);
      setRegistered(message);
    } catch (err: any) {
      setError(err.message || 'Failed to register');
    } finally {
      setLoading(false);
    }
  };

  if (!publicRegistration) {
    return (
      <div className="min-h-screen bg-white flex flex-col justify-center items-center px-4 py-12">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-3 flex flex-col items-center">
            <Link href="/" className="inline-block hover:opacity-90 transition mb-2">
              <Logo size="xl" priority />
            </Link>
            <div>
              <h2 className="text-2xl font-bold text-slate-100 tracking-tight">
                Registration by Invitation Only
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                This workspace does not offer public sign-up.
              </p>
            </div>
          </div>

          <div className="glass-card p-8 rounded-2xl border border-white/10 shadow-2xl text-center space-y-4">
            <p className="text-sm text-slate-300">
              Accounts are created by invitation. If you received an invitation
              email, accept it below to set up your account.
            </p>
            <Link
              href="/invitation-accept"
              className="inline-block px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition"
            >
              Accept invitation
            </Link>
            <p className="text-xs text-slate-500">
              Already have an account?{' '}
              <Link href="/login" className="text-indigo-300 hover:text-indigo-200 underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Header with Logo */}
        <div className="text-center space-y-3 flex flex-col items-center">
          <Link href="/" className="inline-block hover:opacity-90 transition mb-2">
            <Logo size="xl" priority />
          </Link>
          <div>
            <h2 className="text-2xl font-bold text-slate-100 tracking-tight">Create Account</h2>
            <p className="text-xs text-slate-400 mt-1">Join the Neoteric Digital Employee Management System</p>
          </div>
        </div>

        <div className="glass-card p-8 rounded-2xl border border-white/10 shadow-2xl">
          {registered ? (
            <div className="text-center space-y-4">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm font-medium">
                {registered}
              </div>
              <p className="text-xs text-slate-400">
                Click the verification link in the email to activate your account, then sign in.
              </p>
              <Link
                href="/login"
                className="inline-block px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
          <>
          {error && (
            <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="register-first-name" className="block text-xs font-medium text-slate-300 mb-1.5">First Name</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    id="register-first-name"
                    name="firstName"
                    type="text"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="John"
                    className="w-full pl-9 pr-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 focus:border-primary-500 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="register-last-name" className="block text-xs font-medium text-slate-300 mb-1.5">Last Name</label>
                <input
                  id="register-last-name"
                  name="lastName"
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Rahman"
                  className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 focus:border-primary-500 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="register-email" className="block text-xs font-medium text-slate-300 mb-1.5">Work Email</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  id="register-email"
                  name="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="sadia.rahman@ems.local"
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 focus:border-primary-500 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="register-password" className="block text-xs font-medium text-slate-300 mb-1.5">Password</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  id="register-password"
                  name="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 chars with mixed case"
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 focus:border-primary-500 text-xs text-slate-100 placeholder:text-slate-500 outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-primary-600 hover:bg-primary-500 text-white text-xs font-semibold shadow-glow transition flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
            >
              <span>{loading ? 'Creating Account...' : 'Register Account'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
          </>
          )}
        </div>

        <p className="text-center text-xs text-slate-500">
          Already registered?{' '}
          <Link href="/login" className="text-primary-400 hover:underline">
            Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}
