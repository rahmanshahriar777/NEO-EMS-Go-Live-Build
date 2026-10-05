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
  detail: (id: string) => [...employeeKeys.all, 'detail', id] as const,
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
  list: (page: number, limit: number, canViewRuns = true) =>
    [...payrollKeys.all, 'list', page, limit, canViewRuns] as const,
};

export function usePayrollQuery(page: number, limit: number, canViewRuns = true) {
  return useQuery({
    queryKey: payrollKeys.list(page, limit, canViewRuns),
    queryFn: async () => {
      const [runsRes, slipsRes] = await Promise.all([
        canViewRuns
          ? api.getPaginated<any>('/payroll/runs', { params: { page: 1, limit: 10 } }).catch(() => ({ items: [], total: 0, page: 1, limit: 10 }))
          : Promise.resolve({ items: [], total: 0, page: 1, limit: 10 }),
        api.getPaginated<any>('/payroll/payslips', { params: { page, limit } }),
      ]);
      return { runs: runsRes.items || [], payslips: slipsRes };
    },
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

export const attendanceKeys = {
  all: ['attendance'] as const,
  list: (tab: 'my' | 'team', page: number, limit: number) =>
    [...attendanceKeys.all, 'list', tab, page, limit] as const,
  today: () => [...attendanceKeys.all, 'today'] as const,
  corrections: () => [...attendanceKeys.all, 'corrections'] as const,
};

export function useAttendanceListQuery(tab: 'my' | 'team', page: number, limit: number) {
  return useQuery({
    queryKey: attendanceKeys.list(tab, page, limit),
    queryFn: () =>
      api.getPaginated<any>(tab === 'my' ? '/attendance/me' : '/attendance/team', {
        params: { page, limit },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useAttendanceCorrectionsQuery(enabled = true) {
  return useQuery({
    queryKey: attendanceKeys.corrections(),
    queryFn: async () => {
      const res = await api.get<any>('/attendance/corrections');
      return Array.isArray(res) ? res : res?.items || [];
    },
    enabled,
  });
}

export function useMyAttendanceTodayQuery() {
  return useQuery({
    queryKey: attendanceKeys.today(),
    queryFn: () => api.getPaginated<any>('/attendance/me', { params: { limit: 15 } }),
  });
}

/* ------------------------------------------------------------------ */
/* Calendar Events                                                     */
/* ------------------------------------------------------------------ */

export const calendarKeys = {
  all: ['calendar'] as const,
  range: (from: string, to: string) => [...calendarKeys.all, 'range', from, to] as const,
};

export function useCalendarEventsQuery(from: string, to: string) {
  return useQuery({
    queryKey: calendarKeys.range(from, to),
    queryFn: () => api.get<any>('/calendar', { params: { from, to } }),
    enabled: Boolean(from && to),
  });
}

/* ------------------------------------------------------------------ */
/* Audit Logs                                                          */
/* ------------------------------------------------------------------ */

export const auditKeys = {
  all: ['audit-logs'] as const,
  list: (page: number, limit: number) => [...auditKeys.all, 'list', page, limit] as const,
};

export function useAuditLogsQuery(page: number, limit: number, enabled = true) {
  return useQuery({
    queryKey: auditKeys.list(page, limit),
    queryFn: () =>
      api.getPaginated<any>('/audit', {
        params: { page, limit },
      }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Admin Users & Roles                                                 */
/* ------------------------------------------------------------------ */

export const adminKeys = {
  all: ['admin'] as const,
  users: (page: number, limit: number) => [...adminKeys.all, 'users', page, limit] as const,
  roles: () => [...adminKeys.all, 'roles'] as const,
};

export function useAdminUsersQuery(page: number, limit: number, enabled = true) {
  return useQuery({
    queryKey: adminKeys.users(page, limit),
    queryFn: () =>
      api.getPaginated<any>('/auth/users', {
        params: { page, limit },
      }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useAdminRolesQuery(enabled = true) {
  return useQuery({
    queryKey: adminKeys.roles(),
    queryFn: async () => {
      const res = await api.get<any>('/roles');
      return Array.isArray(res) ? res : res?.items || [];
    },
    enabled,
  });
}

/* ------------------------------------------------------------------ */
/* Security Sessions & MFA                                             */
/* ------------------------------------------------------------------ */

export const securityKeys = {
  all: ['security'] as const,
  sessions: () => [...securityKeys.all, 'sessions'] as const,
  mfa: () => [...securityKeys.all, 'mfa'] as const,
};

export function useSessionsQuery() {
  return useQuery({
    queryKey: securityKeys.sessions(),
    queryFn: async () => {
      const res = await api.get<any>('/auth/sessions');
      const rawList = Array.isArray(res)
        ? res
        : Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res?.items)
        ? res.items
        : [];
      return rawList.map((s: any) => ({
        id: s.id || s.familyId,
        ipAddress: s.ipAddress || s.createdIp,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt || s.createdAt,
        current: s.current,
      }));
    },
  });
}

export function useMfaStatusQuery() {
  return useQuery({
    queryKey: securityKeys.mfa(),
    queryFn: () => api.get<any>('/mfa/status'),
  });
}

/* ------------------------------------------------------------------ */
/* Rostering                                                           */
/* ------------------------------------------------------------------ */

export const rosteringKeys = {
  all: ['rostering'] as const,
  range: (from: string, to: string) => [...rosteringKeys.all, 'range', from, to] as const,
};

export function useRosteringQuery(from: string, to: string) {
  return useQuery({
    queryKey: rosteringKeys.range(from, to),
    queryFn: () => api.get<any>('/rostering', { params: { from, to } }),
    enabled: Boolean(from && to),
  });
}

/* ------------------------------------------------------------------ */
/* Performance: Goals, Cycles, Reviews, Feedback                       */
/* ------------------------------------------------------------------ */

export const performanceKeys = {
  all: ['performance'] as const,
  goals: (page: number, limit: number) => [...performanceKeys.all, 'goals', page, limit] as const,
  cycles: () => [...performanceKeys.all, 'cycles'] as const,
  reviews: (page: number, limit: number) => [...performanceKeys.all, 'reviews', page, limit] as const,
  feedback: () => [...performanceKeys.all, 'feedback'] as const,
};

export function useGoalsQuery(page: number, limit: number) {
  return useQuery({
    queryKey: performanceKeys.goals(page, limit),
    queryFn: () => api.getPaginated<any>('/goals', { params: { page, limit } }),
    placeholderData: keepPreviousData,
  });
}

export function useReviewCyclesQuery() {
  return useQuery({
    queryKey: performanceKeys.cycles(),
    queryFn: async () => {
      const res = await api.get<any>('/performance/cycles');
      return Array.isArray(res) ? res : res?.items || [];
    },
  });
}

export function useReviewsQuery(page: number, limit: number) {
  return useQuery({
    queryKey: performanceKeys.reviews(page, limit),
    queryFn: () => api.getPaginated<any>('/performance/reviews', { params: { page, limit } }),
    placeholderData: keepPreviousData,
  });
}

export function useFeedbackQuery() {
  return useQuery({
    queryKey: performanceKeys.feedback(),
    queryFn: async () => {
      const res = await api.get<any>('/feedback');
      return Array.isArray(res) ? res : res?.items || [];
    },
  });
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const documentKeys = {
  all: ['documents'] as const,
  list: (page: number, limit: number, category?: string) =>
    [...documentKeys.all, 'list', page, limit, category || ''] as const,
};

export function useDocumentsQuery(page: number, limit: number, category?: string) {
  return useQuery({
    queryKey: documentKeys.list(page, limit, category),
    queryFn: () =>
      api.getPaginated<any>('/documents', {
        params: {
          page,
          limit,
          category: category === 'ALL' ? undefined : category,
        },
      }),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------------ */
/* Employee Detail                                                     */
/* ------------------------------------------------------------------ */

export function useEmployeeDetailQuery(id: string) {
  return useQuery({
    queryKey: employeeKeys.detail(id),
    queryFn: () => api.get<any>(`/employees/${id}`),
    enabled: Boolean(id),
  });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export const notificationKeys = {
  all: ['notifications'] as const,
  list: () => [...notificationKeys.all, 'list'] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
};

export function useNotificationsQuery(enabled = true) {
  return useQuery({
    queryKey: notificationKeys.list(),
    queryFn: () => api.get<any>('/notifications'),
    enabled,
  });
}

export function useUnreadCountQuery() {
  return useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: () => api.get<{ unreadCount: number }>('/notifications/unread-count'),
  });
}

