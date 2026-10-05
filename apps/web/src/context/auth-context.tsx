'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api-client';
import { AuthUserResponse, SystemRole } from '@ems/shared';

interface AuthContextType {
  user: AuthUserResponse | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, pass: string, redirectTo?: string) => Promise<void>;
  register: (email: string, pass: string, firstName: string, lastName: string) => Promise<string>;
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
        const res = await api.post('/auth/login', { email, password });
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
    try {
      // Cookie-based: the API clears ems_at/ems_rt from the request cookies.
      await api.post('/auth/logout', {});
    } catch {
      // Logout locally even if the API call fails.
    } finally {
      setUser(null);
      router.push('/login');
    }
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
        login,
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
