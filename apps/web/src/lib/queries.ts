/**
 * Shared React Query fetchers + query keys for the highest-value pages.
 *
 * Coherent partial migration (go-live hardening, Phase 3 item 7): dashboard,
 * employees, and leaves are the three most-visited data pages, so they move
 * first. Every other page keeps its existing useState/useEffect fetching —
 * behaviour is preserved, and the remaining pages are listed in the go-live
 * report as follow-up work rather than rushed into a half-done migration.
 *
 * All fetchers go through the central `api` client (cookie sessions, CSRF,
 * retry, 401 bounce) so nothing about auth behaviour changes.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, Paginated } from './api-client';

/* ------------------------------------------------------------------ */
/* Dashboard KPIs                                                      */
/* ------------------------------------------------------------------ */

export interface KpiResponse {
  scope: 'company' | 'team' | 'self';
  generatedAt: string;
  headcount: { total: number; byStatus: Record<string, number> } | null;
  attendanceToday: {
    date: string;
    total: number;
    present: number;
    late: number;
    halfDay: number;
    absent: number;
    onLeave: number;
  } | null;
  pendingApprovals: { leaveRequests: number; total: number } | null;
  leaveBalances: Array<{
    leaveType: string;
    code: string;
    allocated: number;
    used: number;
    pending: number;
    remaining: number;
  }> | null;
  payrollCost: {
    month: number;
    year: number;
    status: string;
    totalGross: number;
    totalDeductions: number;
    totalNet: number;
    payslipCount: number;
  } | null;
}

export const kpiKeys = {
  all: ['kpis'] as const,
};

export function useDashboardKpis() {
  return useQuery({
    queryKey: kpiKeys.all,
    // Role-aware KPIs from the single dashboard endpoint; scope is resolved
    // server-side via the access policy.
    queryFn: () => api.get<KpiResponse>('/dashboard/kpis'),
  });
}

/* ------------------------------------------------------------------ */
/* Employees directory                                                 */
/* ------------------------------------------------------------------ */

export interface EmployeeListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  department?: { id?: string; name: string };
  designation?: { id?: string; title: string };
  status: string;
  createdAt?: string;
}

export const employeeKeys = {
  all: ['employees'] as const,
  list: (page: number, limit: number, search: string) =>
    [...employeeKeys.all, 'list', page, limit, search] as const,
};

export function useEmployeesPage(page: number, limit: number, search: string) {
  return useQuery({
    queryKey: employeeKeys.list(page, limit, search),
    queryFn: () =>
      api.getPaginated<EmployeeListItem>('/employees', {
        params: { search: search || undefined, page, limit },
      }),
    // Keep the previous page visible while the next one loads — smoother
    // than blanking the grid on every page turn.
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Leaves                                                              */
/* ------------------------------------------------------------------ */

export interface LeaveBalance {
  id?: string;
  leaveType?: { id?: string; name: string };
  allocatedDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface LeaveRequest {
  id: string;
  employee?: {
    id?: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
  };
  leaveType?: { id?: string; name: string };
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt?: string;
}

export interface LeaveType {
  id: string;
  name: string;
  defaultDaysPerYear: number;
}

export interface LeavePageData {
  requests: Paginated<LeaveRequest>;
  balances: LeaveBalance[];
  types: LeaveType[];
}

export const leaveKeys = {
  all: ['leaves'] as const,
  page: (page: number, limit: number) => [...leaveKeys.all, 'page', page, limit] as const,
};

export function useLeavePage(page: number, limit: number) {
  return useQuery({
    queryKey: leaveKeys.page(page, limit),
    queryFn: async (): Promise<LeavePageData> => {
      // NOTE: no mock fallbacks — an API failure shows a loud error, not
      // invented data. Balances/types are best-effort (older API builds may
      // lack them), but the request list itself must succeed.
      const [requests, balRes, typesRes] = await Promise.all([
        api.getPaginated<LeaveRequest>('/leave-requests', {
          params: { page, limit },
        }),
        api.get('/leave-balances').catch(() => null),
        api.get('/leave-types').catch(() => null),
      ]);
      const balances: LeaveBalance[] = Array.isArray(balRes)
        ? balRes
        : balRes?.items || [];
      const types: LeaveType[] = Array.isArray(typesRes)
        ? typesRes
        : typesRes?.items || [];
      return { requests, balances, types };
    },
    placeholderData: keepPreviousData,
  });
}
