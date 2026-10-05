import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import InvitationAcceptPage from './page';

const { apiPostMock, pushMock } = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('../../../lib/api-client', () => ({
  api: { post: apiPostMock },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === 'token' ? 'invite-tok-456' : null),
  }),
  useRouter: () => ({ push: pushMock }),
}));

const NEW_PASSWORD = 'BrandNewPassword789!';

async function submitForm(firstName = 'Jane', lastName = 'Smith') {
  render(<InvitationAcceptPage />);
  fireEvent.change(screen.getByLabelText('First Name'), {
    target: { value: firstName },
  });
  fireEvent.change(screen.getByLabelText('Last Name'), {
    target: { value: lastName },
  });
  fireEvent.change(screen.getByLabelText('New Password (min. 12 characters)'), {
    target: { value: NEW_PASSWORD },
  });
  fireEvent.change(screen.getByLabelText('Confirm Password'), {
    target: { value: NEW_PASSWORD },
  });
  const form = screen
    .getByRole('button', { name: /activate account/i })
    .closest('form')!;
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('invitation-accept payload shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPostMock.mockResolvedValue({});
  });

  it('posts { token, password, firstName, lastName } matching AcceptInvitationDto', async () => {
    await submitForm();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith('/auth/invitations/accept', {
      token: 'invite-tok-456',
      password: NEW_PASSWORD,
      firstName: 'Jane',
      lastName: 'Smith',
    });
    await screen.findByText('Account activated');
  });

  it('trims surrounding whitespace from the names', async () => {
    await submitForm('  Jane ', 'Smith  ');
    const payload = apiPostMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.firstName).toBe('Jane');
    expect(payload.lastName).toBe('Smith');
  });

  it('blocks submission when the names are missing', async () => {
    render(<InvitationAcceptPage />);
    fireEvent.change(screen.getByLabelText('New Password (min. 12 characters)'), {
      target: { value: NEW_PASSWORD },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: NEW_PASSWORD },
    });
    const form = screen
      .getByRole('button', { name: /activate account/i })
      .closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Please enter your first and last name.'),
    ).toBeDefined();
  });
});
