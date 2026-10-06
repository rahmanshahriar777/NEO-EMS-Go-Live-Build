import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import RecruitmentPage from './page';

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../../../context/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'u1', firstName: 'Admin', roles: ['SUPER_ADMIN'] },
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

describe('RecruitmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders recruitment dashboard and vacancies', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url === '/recruitment/vacancies') {
        return Promise.resolve([
          {
            id: 'v1',
            title: 'Lead Software Architect',
            status: 'OPEN',
            postedAt: '2026-10-01T10:00:00Z',
            _count: { candidates: 2 },
          },
        ]);
      }
      if (url.includes('/candidates')) {
        return Promise.resolve([
          {
            id: 'c1',
            vacancyId: 'v1',
            firstName: 'Grace',
            lastName: 'Hopper',
            email: 'grace@example.com',
            stage: 'APPLIED',
            createdAt: '2026-10-02T10:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => {
      render(<RecruitmentPage />);
    });

    expect(screen.getByText('Recruitment & Talent Pipeline')).toBeTruthy();
    const vacElements = await screen.findAllByText('Lead Software Architect');
    expect(vacElements.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  });
});
