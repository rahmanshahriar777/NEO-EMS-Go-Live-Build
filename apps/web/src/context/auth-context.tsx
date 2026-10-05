'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api-client';
import { AuthUserResponse, SystemRole } from '@ems/shared';

interface AuthContextType {
  user: AuthUserResponse | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Non-null while a second-factor challenge is in progress (login returned
   * `mfaRequired: true`). The challenge screen reads this token and completes
   * it via `completeMfaChallenge`.
   */
  mfaChallengeToken: string | null;
  login: (email: string, pass: string, redirectTo?: string) => Promise<void>;
  /**
   * Complete the pending MFA challenge: POST /mfa/challenge
   * { challengeToken, code } (TOTP code or recovery code). On success the
   * session cookies are set by the API and the user is signed in.
   */
  completeMfaChallenge: (code: string) => Promise<void>;
  /** Clear a pending MFA challenge without completing it. */
  cancelMfaChallenge: () => void;
  register: (email: string, pass: string, firstName: string, lastName: string) => Promise<string>;
  /**
   * Sign out. Rejects when the API logout cannot be confirmed (after bounded
   * retries): the session is then left intact and the caller MUST surface the
   * error — the UI must never show "logged out" while refresh tokens may
   * still be valid. A 401 is treated as "already signed out" (the api-client
   * only surfaces 401 after a failed refresh, so the session is dead).
   */
  logout: () => Promise<void>;
  hasRole: (...roles: SystemRole[]) => boolean;
  hasPermission: (permission: string) => boolean;
  updateUserAvatar: (avatarUrl: string | null) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Session state lives ONLY in memory. Tokens are httpOnly cookies
  // (`ems_at` / `ems_rt`) set by the API — never in localStorage, so they
  // are not readable by JavaScript (XSS cannot steal them).
  const [user, setUser] = useState<AuthUserResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Pending MFA second-factor state: set when POST /auth/login answers
  // { mfaRequired: true, challengeToken }. The user is NOT signed in yet —
  // no session cookies exist — until completeMfaChallenge succeeds.
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [pendingRedirect, setPendingRedirect] = useState<string>('/dashboard');
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const restoreSession = async () => {
      try {
        // The API reads the ems_at cookie; a 401 here simply means "signed out".
        const me = await api.get<AuthUserResponse>('/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const extractUser = (res: any): AuthUserResponse => {
    // The API sets httpOnly cookies on login/register; the body carries the profile.
    const profile = res?.user ?? res;
    if (!profile || typeof profile !== 'object' || !profile.email) {
      throw new Error('Unexpected authentication response from the API.');
    }
    return profile as AuthUserResponse;
  };

  const login = useCallback(
    async (email: string, password: string, redirectTo: string = '/dashboard') => {
      setIsLoading(true);
      try {
        api.clearSessionExpired();
        // Drop any stale challenge from an earlier aborted attempt.
        setMfaChallengeToken(null);
        const res = await api.post('/auth/login', { email, password });
        // MFA-enrolled user: the password passed but no session was issued.
        // Route to the second-factor step; the challenge token is short-lived
        // and single-purpose (POST /mfa/challenge).
        if (res && typeof res === 'object' && (res as any).mfaRequired === true) {
          const challengeToken = (res as any).challengeToken;
          if (typeof challengeToken !== 'string' || !challengeToken) {
            throw new Error(
              'The API requested a second factor but did not issue a challenge token.',
            );
          }
          setMfaChallengeToken(challengeToken);
          setPendingRedirect(redirectTo);
          // The caller (login page) passes the validated ?next= destination;
          // it must already have been through resolveSafeNextPath().
          router.push('/mfa-challenge');
          return;
        }
        setUser(extractUser(res));
        // The caller (login page) passes the validated ?next= destination;
        // it must already have been through resolveSafeNextPath().
        router.push(redirectTo);
      } finally {
        setIsLoading(false);
      }
    },
    [router],
  );

  const completeMfaChallenge = useCallback(
    async (code: string) => {
      if (!mfaChallengeToken) {
        throw new Error('No second-factor challenge is in progress. Sign in again.');
      }
      setIsLoading(true);
      try {
        api.clearSessionExpired();
        // API contract: POST /mfa/challenge { challengeToken, code } —
        // `code` is a 6-digit TOTP code or an unused recovery code. The API
        // sets the httpOnly session cookies; the body carries the profile.
        const res = await api.post('/mfa/challenge', {
          challengeToken: mfaChallengeToken,
          code,
        });
        setMfaChallengeToken(null);
        setUser(extractUser(res));
        const destination = pendingRedirect;
        setPendingRedirect('/dashboard');
        router.push(destination);
      } finally {
        setIsLoading(false);
      }
    },
    [mfaChallengeToken, pendingRedirect, router],
  );

  const cancelMfaChallenge = useCallback(() => {
    setMfaChallengeToken(null);
    setPendingRedirect('/dashboard');
    router.push('/login');
  }, [router]);

  const register = useCallback(
    async (email: string, password: string, firstName: string, lastName: string) => {
      setIsLoading(true);
      try {
        api.clearSessionExpired();
        // The API issues NO session at registration: email verification is
        // required first. Show the returned message ("check your inbox")
        // instead of signing the user in.
        const res = await api.post<{ user?: unknown; message?: string }>('/auth/register', {
          email,
          password,
          firstName,
          lastName,
        });
        return res?.message || 'Account created. Please check your inbox to verify your email.';
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    // The API clears the ems_at/ems_rt cookies. The local session must only
    // be dropped once that is CONFIRMED: if the request cannot reach the API,
    // the refresh token is probably still valid server-side, so clearing
    // local state (or navigating to /login) would lie to the user and leave a
    // live session behind. Retry transient failures, then throw so the caller
    // can show a retry affordance while the user stays signed in.
    const MAX_ATTEMPTS = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Cookie-based: the API clears ems_at/ems_rt from the request cookies.
        await api.post('/auth/logout', {});
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        // 401 after the api-client's refresh attempt means the session is
        // already dead server-side — local logout is honest here.
        if (err?.status === 401) {
          lastError = null;
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }
    if (lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error('Sign out failed. You are still signed in — please try again.');
    }
    setUser(null);
    setMfaChallengeToken(null);
    setPendingRedirect('/dashboard');
    router.push('/login');
  }, [router]);

  const hasRole = useCallback(
    (...roles: SystemRole[]): boolean => {
      if (!user || !user.roles) return false;
      return roles.some((r) => user.roles.includes(r));
    },
    [user],
  );

  const hasPermission = useCallback(
    (permission: string): boolean => {
      if (!user || !user.permissions) return false;
      return user.permissions.includes(permission);
    },
    [user],
  );

  const updateUserAvatar = useCallback(
    (avatarUrl: string | null) => {
      if (!user) return;
      setUser({ ...user, avatarUrl: avatarUrl || undefined });
    },
    [user],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        mfaChallengeToken,
        login,
        completeMfaChallenge,
        cancelMfaChallenge,
        register,
        logout,
        hasRole,
        hasPermission,
        updateUserAvatar,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
