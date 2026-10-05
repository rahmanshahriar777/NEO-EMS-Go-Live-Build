import { SystemRole, EmploymentStatus, AttendanceStatus, LeaveStatus, PayrollStatus, ReviewStatus } from '../enums/index.js';

export type UUID = string;
export type DateString = string; // ISO 8601 string
export type CurrencyAmount = number; // in minor units (e.g. cents) or standard 2-decimal rounded number

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data: T;
  meta?: Record<string, any>;
  timestamp?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: any;
    timestamp: string;
    path?: string;
  };
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  meta: PaginationMeta;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
}

// Authentication & Identity Types
export interface JwtPayload {
  sub: UUID; // User ID
  email: string;
  roles: SystemRole[];
  permissions: string[]; // e.g. "EMPLOYEE:READ", "PAYROLL:APPROVE"
  employeeId?: UUID;
  iat?: number;
  exp?: number;
}

export interface TokensResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // in seconds
}

export interface AuthUserResponse {
  id: UUID;
  email: string;
  firstName?: string;
  lastName?: string;
  roles: SystemRole[];
  permissions: string[];
  employeeId?: UUID;
  employeeNumber?: string;
  avatarUrl?: string;
}

export interface AuthSession {
  user: AuthUserResponse;
  tokens: TokensResponse;
}

// Employee Domain Types
export interface EmployeeSummary {
  id: UUID;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  departmentId?: UUID;
  departmentName?: string;
  designationId?: UUID;
  designationTitle?: string;
  managerId?: UUID;
  managerName?: string;
  status: EmploymentStatus;
  joiningDate: DateString;
  avatarUrl?: string;
}

export interface DepartmentSummary {
  id: UUID;
  name: string;
  code: string;
  description?: string;
  headEmployeeId?: UUID;
  headEmployeeName?: string;
  employeeCount?: number;
}

export interface DesignationSummary {
  id: UUID;
  title: string;
  code: string;
  departmentId?: UUID;
  level: number;
}

// Attendance & Leave Types
export interface AttendanceSummary {
  id: UUID;
  employeeId: UUID;
  employeeName?: string;
  date: DateString;
  clockInTime?: DateString;
  clockOutTime?: DateString;
  status: AttendanceStatus;
  totalHoursWorked?: number;
  anomalyFlag?: boolean;
}

export interface LeaveBalanceSummary {
  id: UUID;
  employeeId: UUID;
  leaveTypeId: UUID;
  leaveTypeName: string;
  year: number;
  allocatedDays: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
}

// Payroll Types
export interface PayslipSummary {
  id: UUID;
  employeeId: UUID;
  employeeName: string;
  employeeNumber: string;
  payrollRunId: UUID;
  periodMonth: number;
  periodYear: number;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  status: PayrollStatus;
  disbursementDate?: DateString;
}
