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

/* ------------------------------------------------------------------ */
/* Departments                                                         */
/* ------------------------------------------------------------------ */

export const departmentKeys = {
  all: ['departments'] as const,
  list: (page: number, limit: number) => [...departmentKeys.all, 'list', page, limit] as const,
};

export function useDepartmentsQuery(page: number, limit: number) {
  return useQuery({
    queryKey: departmentKeys.list(page, limit),
    queryFn: () => api.getPaginated<any>('/departments', { params: { page, limit } }),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Payroll                                                             */
/* ------------------------------------------------------------------ */

export const payrollKeys = {
  all: ['payroll'] as const,
  list: (page: number, limit: number) => [...payrollKeys.all, 'list', page, limit] as const,
};

export function usePayrollQuery(page: number, limit: number) {
  return useQuery({
    queryKey: payrollKeys.list(page, limit),
    queryFn: async () => {
      const [runs, payslips] = await Promise.all([
        api.get<any[]>('/payroll/runs').catch(() => []),
        api.getPaginated<any>('/payroll/payslips', { params: { page, limit } }),
      ]);
      return { runs: Array.isArray(runs) ? runs : (runs as any)?.items || [], payslips };
    },
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

export const attendanceKeys = {
  all: ['attendance'] as const,
  today: (date: string) => [...attendanceKeys.all, 'today', date] as const,
  my: (page: number, limit: number) => [...attendanceKeys.all, 'my', page, limit] as const,
};

export function useAttendanceTodayQuery(date: string) {
  return useQuery({
    queryKey: attendanceKeys.today(date),
    queryFn: () => api.get<any[]>('/attendance/today', { params: { date } }),
  });
}

export function useMyAttendanceQuery(page: number, limit: number) {
  return useQuery({
    queryKey: attendanceKeys.my(page, limit),
    queryFn: () => api.getPaginated<any>('/attendance/my', { params: { page, limit } }),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Calendar Events                                                     */
/* ------------------------------------------------------------------ */

export const calendarKeys = {
  all: ['calendar'] as const,
  month: (month: number, year: number) => [...calendarKeys.all, 'month', month, year] as const,
};

export function useCalendarQuery(month: number, year: number) {
  return useQuery({
    queryKey: calendarKeys.month(month, year),
    queryFn: () => api.get<any[]>('/calendar/events', { params: { month, year } }),
  });
}

/* ------------------------------------------------------------------ */
/* Audit Logs                                                          */
/* ------------------------------------------------------------------ */

export const auditKeys = {
  all: ['audit-logs'] as const,
  list: (page: number, limit: number, action?: string, search?: string) =>
    [...auditKeys.all, 'list', page, limit, action || '', search || ''] as const,
};

export function useAuditLogsQuery(page: number, limit: number, action?: string, search?: string) {
  return useQuery({
    queryKey: auditKeys.list(page, limit, action, search),
    queryFn: () =>
      api.getPaginated<any>('/audit-logs', {
        params: { page, limit, action: action || undefined, search: search || undefined },
      }),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Admin Users & Roles                                                 */
/* ------------------------------------------------------------------ */

export const adminKeys = {
  all: ['admin'] as const,
  users: (page: number, limit: number, search?: string) =>
    [...adminKeys.all, 'users', page, limit, search || ''] as const,
  roles: () => [...adminKeys.all, 'roles'] as const,
};

export function useAdminUsersQuery(page: number, limit: number, search?: string) {
  return useQuery({
    queryKey: adminKeys.users(page, limit, search),
    queryFn: () =>
      api.getPaginated<any>('/users', {
        params: { page, limit, search: search || undefined },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useAdminRolesQuery() {
  return useQuery({
    queryKey: adminKeys.roles(),
    queryFn: () => api.get<any[]>('/roles'),
  });
}

