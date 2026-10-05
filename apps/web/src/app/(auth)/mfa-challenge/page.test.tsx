import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MfaChallengePage from './page';

const { completeMock, cancelMock, authState } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  cancelMock: vi.fn(),
  authState: {
    mfaChallengeToken: 'chal-123',
    isLoading: false,
  } as { mfaChallengeToken: string | null; isLoading: boolean },
}));

vi.mock('../../../context/auth-context', () => ({
  useAuth: () => ({
    mfaChallengeToken: authState.mfaChallengeToken,
    completeMfaChallenge: completeMock,
    cancelMfaChallenge: cancelMock,
    isLoading: authState.isLoading,
  }),
}));

describe('mfa-challenge page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.mfaChallengeToken = 'chal-123';
    authState.isLoading = false;
    completeMock.mockResolvedValue(undefined);
  });

  it('submits a 6-digit TOTP code to completeMfaChallenge', async () => {
    render(<MfaChallengePage />);
    fireEvent.change(screen.getByLabelText('Authenticator code (6 digits)'), {
      target: { value: '123456' },
    });
    const form = screen
      .getByRole('button', { name: /verify & sign in/i })
      .closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith('123456');
  });

  it('rejects a malformed TOTP code client-side', async () => {
    render(<MfaChallengePage />);
    fireEvent.change(screen.getByLabelText('Authenticator code (6 digits)'), {
      target: { value: '12ab' },
    });
    const form = screen
      .getByRole('button', { name: /verify & sign in/i })
      .closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(completeMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Enter the 6-digit code from your authenticator app.'),
    ).toBeDefined();
  });

  it('offers the recovery-code alternative, which skips the 6-digit check', async () => {
    render(<MfaChallengePage />);
    fireEvent.click(
      screen.getByRole('button', { name: /use a recovery code/i }),
    );
    expect(
      screen.getByLabelText('Recovery code'),
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText('Recovery code'), {
      target: { value: 'R3C0V3RY-C0D3-XYZ' },
    });
    const form = screen
      .getByRole('button', { name: /verify & sign in/i })
      .closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(completeMock).toHaveBeenCalledWith('R3C0V3RY-C0D3-XYZ');
  });

  it('surfaces challenge failures without navigating away', async () => {
    completeMock.mockRejectedValueOnce(new Error('Invalid code'));
    render(<MfaChallengePage />);
    fireEvent.change(screen.getByLabelText('Authenticator code (6 digits)'), {
      target: { value: '000000' },
    });
    const form = screen
      .getByRole('button', { name: /verify & sign in/i })
      .closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(await screen.findByText('Invalid code')).toBeDefined();
  });

  it('shows a "back to sign in" state when no challenge is in progress', () => {
    authState.mfaChallengeToken = null;
    render(<MfaChallengePage />);
    expect(
      screen.getByText(/no second-factor challenge is in progress/i),
    ).toBeDefined();
    expect(
      screen.getByRole('link', { name: /back to sign in/i }),
    ).toHaveAttribute('href', '/login');
  });

  it('cancel returns to the login page', () => {
    render(<MfaChallengePage />);
    fireEvent.click(
      screen.getByRole('button', { name: /cancel and return to sign in/i }),
    );
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });
});
