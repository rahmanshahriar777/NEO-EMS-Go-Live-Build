import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import OnboardingPage from './page';

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../../../context/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u1', firstName: 'Admin', roles: ['HR_ADMIN'] },
    hasRole: () => true,
  }),
}));

vi.mock('../../../lib/api-client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
  },
}));

vi.mock('../../../components/layout/dashboard-layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders onboarding and offboarding checklists', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/onboarding/checklists') {
        return Promise.resolve([
          {
            id: 'chk-1',
            employeeId: 'emp-1',
            kind: 'ONBOARDING',
            status: 'IN_PROGRESS',
            createdAt: '2026-10-01T10:00:00Z',
            tasks: [
              {
                id: 't1',
                checklistId: 'chk-1',
                title: 'Collect right-to-work documents',
                ownerRole: 'HR',
                status: 'PENDING',
              },
            ],
          },
        ]);
      }
      if (url === '/employees') {
        return Promise.resolve([
          {
            id: 'emp-1',
            firstName: 'Alan',
            lastName: 'Turing',
            email: 'alan@example.com',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => {
      render(<OnboardingPage />);
    });

    expect(screen.getByText('Onboarding & Offboarding Lifecycle')).toBeTruthy();
    const empElements = await screen.findAllByText('Alan Turing');
    expect(empElements.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('Collect right-to-work documents')).toBeTruthy();
  });
});
