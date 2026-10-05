import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionsPage from './page';

const { logoutMock, apiGetMock, apiDeleteMock } = vi.hoisted(() => ({
  logoutMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiDeleteMock: vi.fn(),
}));

vi.mock('../../../../context/auth-context', () => ({
  useAuth: () => ({ logout: logoutMock }),
}));

vi.mock('../../../../lib/api-client', () => ({
  api: { get: apiGetMock, delete: apiDeleteMock, post: vi.fn() },
}));

vi.mock('../../../../components/layout/dashboard-layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('../../../../components/ui/error-banner', () => ({
  ErrorBanner: ({ detail }: { detail: string }) => (
    <div role="alert">{detail}</div>
  ),
}));

const CURRENT_SESSION = {
  id: 's1',
  current: true,
  ipAddress: '10.0.0.1',
  userAgent: 'Chrome/120.0',
};

describe('sessions page sign-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue([CURRENT_SESSION]);
  });

  it('routes "Sign out" on the current session through useAuth().logout()', async () => {
    logoutMock.mockResolvedValue(undefined);

    render(<SessionsPage />);
    const signOutBtn = await screen.findByRole('button', { name: /sign out/i });
    await act(async () => {
      fireEvent.click(signOutBtn);
    });

    expect(logoutMock).toHaveBeenCalledTimes(1);
    // The raw api.post('/auth/logout') path must not be used for the current
    // session — it navigated to /login in a finally block even on failure.
    expect(apiDeleteMock).not.toHaveBeenCalled();
  });

  it('surfaces sign-out failure inline instead of navigating to /login', async () => {
    logoutMock.mockRejectedValue(
      new Error('Sign out failed. You are still signed in — please try again.'),
    );

    render(<SessionsPage />);
    const signOutBtn = await screen.findByRole('button', { name: /sign out/i });
    await act(async () => {
      fireEvent.click(signOutBtn);
    });

    expect(logoutMock).toHaveBeenCalledTimes(1);
    // The error is shown on this page: the user is NOT sent to /login while
    // the refresh token may still be live server-side.
    expect(
      await screen.findByText(/sign out failed/i),
    ).toBeTruthy();
  });
});
