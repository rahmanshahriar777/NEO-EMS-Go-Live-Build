import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ReportsPage from './page';

const { apiGetMock, apiPostMock, apiDownloadFileMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiDownloadFileMock: vi.fn(),
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
    downloadFile: apiDownloadFileMock,
  },
}));

vi.mock('../../../components/layout/dashboard-layout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders standard executive reports cards', async () => {
    apiGetMock.mockResolvedValue([]);

    await act(async () => {
      render(<ReportsPage />);
    });

    expect(screen.getByText('Reports & Business Intelligence')).toBeTruthy();
    expect(screen.getByText('Headcount & Workforce Demographics')).toBeTruthy();
    expect(screen.getByText('Turnover & Leavers Analysis')).toBeTruthy();
    expect(screen.getByText('Payroll Expenditure & Statutory Costs')).toBeTruthy();
  });
});
