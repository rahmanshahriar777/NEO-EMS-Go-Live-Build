import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ResetPasswordConfirmPage from './page';

const { apiPostMock, pushMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('../../../../lib/api-client', () => ({
  api: { post: apiPostMock },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === 'token' ? 'reset-tok-123' : null),
  }),
  useRouter: () => ({ push: pushMock }),
}));

const NEW_PASSWORD = 'BrandNewPassword789!';

async function submitForm() {
  render(<ResetPasswordConfirmPage />);
  fireEvent.change(screen.getByLabelText('New Password (min. 12 characters)'), {
    target: { value: NEW_PASSWORD },
  });
  fireEvent.change(screen.getByLabelText('Confirm Password'), {
    target: { value: NEW_PASSWORD },
  });
  const form = screen
    .getByRole('button', { name: /set new password/i })
    .closest('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('reset-password/confirm payload shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPostMock.mockResolvedValue({});
  });

  it('posts { token, newPassword } matching ConfirmPasswordResetDto', async () => {
    await submitForm();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith('/auth/password-reset/confirm', {
      token: 'reset-tok-123',
      newPassword: NEW_PASSWORD,
    });
    // The payload must NOT use the old `password` key rejected by the DTO.
    const payload = apiPostMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('password');
    await screen.findByText('Password updated');
  });

  it('surfaces API errors without claiming success', async () => {
    apiPostMock.mockRejectedValueOnce(new Error('Reset link expired'));
    await submitForm();
    expect(await screen.findByText('Reset link expired')).toBeDefined();
    expect(screen.queryByText('Password updated')).toBeNull();
  });
});
