import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { AuthProvider, useAuth } from '../auth-context';

const { apiPostMock, apiGetMock, clearSessionExpiredMock, pushMock } = vi.hoisted(
  () => ({
    apiPostMock: vi.fn(),
    apiGetMock: vi.fn(),
    clearSessionExpiredMock: vi.fn(),
    pushMock: vi.fn(),
  }),
);

vi.mock('../../lib/api-client', () => ({
  api: {
    post: apiPostMock,
    get: apiGetMock,
    clearSessionExpired: clearSessionExpiredMock,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Captures the latest context value on every render.
let latest: ReturnType<typeof useAuth>;
function Probe() {
  latest = useAuth();
  return null;
}

function renderProvider() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const PROFILE = {
  email: 'jane@ems.local',
  firstName: 'Jane',
  lastName: 'Smith',
  roles: [],
  permissions: [],
};

describe('auth-context MFA challenge state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Session restore on mount: no session.
    apiGetMock.mockRejectedValue(new Error('no session'));
    apiPostMock.mockResolvedValue({});
  });

  it('routes to /mfa-challenge (without signing in) when login returns mfaRequired', async () => {
    renderProvider();
    apiPostMock.mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      challengeToken: 'chal-123',
      message: 'Second factor required.',
    });

    await act(async () => {
      await latest.login('jane@ems.local', 'password123', '/employees');
    });

    expect(apiPostMock).toHaveBeenCalledWith('/auth/login', {
      email: 'jane@ems.local',
      password: 'password123',
    });
    // No session was issued: the user must NOT be signed in yet.
    expect(latest.user).toBeNull();
    expect(latest.isAuthenticated).toBe(false);
    expect(latest.mfaChallengeToken).toBe('chal-123');
    expect(pushMock).toHaveBeenCalledWith('/mfa-challenge');
    expect(pushMock).not.toHaveBeenCalledWith('/employees');
  });

  it('completes the challenge via POST /mfa/challenge and signs the user in', async () => {
    renderProvider();
    apiPostMock.mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      challengeToken: 'chal-123',
    });
    await act(async () => {
      await latest.login('jane@ems.local', 'password123', '/employees');
    });

    apiPostMock.mockResolvedValueOnce({ user: PROFILE });
    await act(async () => {
      await latest.completeMfaChallenge('123456');
    });

    expect(apiPostMock).toHaveBeenCalledWith('/mfa/challenge', {
      challengeToken: 'chal-123',
      code: '123456',
    });
    expect(latest.mfaChallengeToken).toBeNull();
    expect(latest.user?.email).toBe('jane@ems.local');
    expect(latest.isAuthenticated).toBe(true);
    // The validated ?next= destination from the login step is honoured.
    expect(pushMock).toHaveBeenCalledWith('/employees');
  });

  it('throws when completing a challenge with none in progress', async () => {
    renderProvider();
    await act(async () => {
      await expect(latest.completeMfaChallenge('123456')).rejects.toThrow(
        'No second-factor challenge is in progress',
      );
    });
    expect(apiPostMock).not.toHaveBeenCalledWith(
      '/mfa/challenge',
      expect.anything(),
    );
  });

  it('keeps the normal (non-MFA) login path unchanged', async () => {
    renderProvider();
    apiPostMock.mockResolvedValueOnce({ user: PROFILE });

    await act(async () => {
      await latest.login('jane@ems.local', 'password123', '/dashboard');
    });

    expect(latest.user?.email).toBe('jane@ems.local');
    expect(latest.mfaChallengeToken).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/dashboard');
    expect(pushMock).not.toHaveBeenCalledWith('/mfa-challenge');
  });

  it('cancelMfaChallenge drops the token and returns to /login', async () => {
    renderProvider();
    apiPostMock.mockResolvedValueOnce({
      success: true,
      mfaRequired: true,
      challengeToken: 'chal-123',
    });
    await act(async () => {
      await latest.login('jane@ems.local', 'password123');
    });
    expect(latest.mfaChallengeToken).toBe('chal-123');

    act(() => {
      latest.cancelMfaChallenge();
    });

    expect(latest.mfaChallengeToken).toBeNull();
    expect(latest.user).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/login');
  });
});

describe('auth-context logout honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockRejectedValue(new Error('no session'));
  });

  async function signIn() {
    renderProvider();
    apiPostMock.mockResolvedValueOnce({ user: PROFILE });
    await act(async () => {
      await latest.login('jane@ems.local', 'password123');
    });
    expect(latest.user?.email).toBe('jane@ems.local');
    pushMock.mockClear();
  }

  it('signs out locally only after the API confirms logout', async () => {
    await signIn();
    apiPostMock.mockResolvedValueOnce({});

    await act(async () => {
      await latest.logout();
    });

    expect(apiPostMock).toHaveBeenCalledWith('/auth/logout', {});
    expect(latest.user).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  it('treats a 401 as "already signed out" and logs out locally', async () => {
    await signIn();
    const gone: any = new Error('Session expired');
    gone.status = 401;
    apiPostMock.mockRejectedValueOnce(gone);

    await act(async () => {
      await latest.logout();
    });

    expect(latest.user).toBeNull();
    expect(pushMock).toHaveBeenCalledWith('/login');
  });

  it('never shows "logged out" when logout cannot be confirmed: retries, then throws, session intact', async () => {
    await signIn();
    apiPostMock.mockRejectedValue(new Error('Network down'));

    await act(async () => {
      await expect(latest.logout()).rejects.toThrow('Network down');
    });

    // Bounded retries: 1 initial + 2 retries.
    const logoutCalls = apiPostMock.mock.calls.filter(
      (c) => c[0] === '/auth/logout',
    );
    expect(logoutCalls).toHaveLength(3);
    // The session is untouched and no redirect happened: the UI must not
    // claim the user is signed out while the refresh token may be valid.
    expect(latest.user?.email).toBe('jane@ems.local');
    expect(latest.isAuthenticated).toBe(true);
    expect(pushMock).not.toHaveBeenCalledWith('/login');
  });
});
