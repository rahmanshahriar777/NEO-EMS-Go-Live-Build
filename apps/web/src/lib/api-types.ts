/**
 * Web API types — OpenAPI 3.0 TypeScript definitions.
 *
 * Provides strongly-typed request and response contracts for @ems/web,
 * generated from and aligned with the backend OpenAPI specification.
 */

export interface paths {
  '/auth/login': {
    post: {
      requestBody: {
        content: {
          'application/json': components['schemas']['LoginDto'];
        };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['AuthResponse'];
          };
        };
      };
    };
  };
  '/auth/me': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['User'];
          };
        };
      };
    };
  };
  '/employees': {
    get: {
      parameters: {
        query?: {
          search?: string;
          departmentId?: string;
          status?: string;
          page?: number;
          limit?: number;
        };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedEmployees'];
          };
        };
      };
    };
    post: {
      requestBody: {
        content: {
          'application/json': components['schemas']['CreateEmployeeDto'];
        };
      };
      responses: {
        201: {
          content: {
            'application/json': components['schemas']['Employee'];
          };
        };
      };
    };
  };
  '/employees/{id}': {
    get: {
      parameters: {
        path: { id: string };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['Employee'];
          };
        };
      };
    };
    patch: {
      parameters: {
        path: { id: string };
      };
      requestBody: {
        content: {
          'application/json': Partial<components['schemas']['CreateEmployeeDto']>;
        };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['Employee'];
          };
        };
      };
    };
  };
  '/departments': {
    get: {
      parameters: {
        query?: {
          entityId?: string;
          sortBy?: string;
          sortOrder?: 'asc' | 'desc';
        };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['Department'][];
          };
        };
      };
    };
    post: {
      requestBody: {
        content: {
          'application/json': components['schemas']['CreateDepartmentDto'];
        };
      };
      responses: {
        201: {
          content: {
            'application/json': components['schemas']['Department'];
          };
        };
      };
    };
  };
  '/payroll/runs': {
    get: {
      parameters: {
        query?: { page?: number; limit?: number };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedPayrollRuns'];
          };
        };
      };
    };
    post: {
      requestBody: {
        content: {
          'application/json': { month: number; year: number };
        };
      };
      responses: {
        201: {
          content: {
            'application/json': components['schemas']['PayrollRun'];
          };
        };
      };
    };
  };
  '/payroll/payslips': {
    get: {
      parameters: {
        query?: { page?: number; limit?: number; runId?: string };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedPayslips'];
          };
        };
      };
    };
  };
  '/attendance/me': {
    get: {
      parameters: {
        query?: { page?: number; limit?: number };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedAttendance'];
          };
        };
      };
    };
  };
  '/leaves': {
    get: {
      parameters: {
        query?: { page?: number; limit?: number; status?: string };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedLeaveRequests'];
          };
        };
      };
    };
  };
  '/documents': {
    get: {
      parameters: {
        query?: { page?: number; limit?: number; category?: string };
      };
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['PaginatedDocuments'];
          };
        };
      };
    };
  };
  '/notifications': {
    get: {
      responses: {
        200: {
          content: {
            'application/json': components['schemas']['Notification'][];
          };
        };
      };
    };
  };
}

export interface components {
  schemas: {
    LoginDto: {
      email: string;
      password: string;
      totpCode?: string;
    };
    AuthResponse: {
      accessToken: string;
      user: components['schemas']['User'];
    };
    User: {
      id: string;
      email: string;
      isActive: boolean;
      emailVerified?: boolean;
      roles: string[];
      permissions?: string[];
      employeeId?: string;
      createdAt?: string;
    };
    Employee: {
      id: string;
      employeeNumber: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      avatarUrl?: string;
      departmentId?: string;
      department?: components['schemas']['Department'];
      designationId?: string;
      designation?: components['schemas']['Designation'];
      status: string;
      joinDate?: string;
      salary?: number;
      currency?: string;
      createdAt?: string;
    };
    CreateEmployeeDto: {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      departmentId?: string;
      designationId?: string;
      status?: string;
      joinDate?: string;
      salary?: number;
      currency?: string;
    };
    Department: {
      id: string;
      name: string;
      code: string;
      description?: string;
      entityId?: string;
      parentDepartmentId?: string;
      managerId?: string;
      isActive: boolean;
      employeeCount?: number;
    };
    CreateDepartmentDto: {
      name: string;
      code: string;
      description?: string;
      entityId?: string;
      parentDepartmentId?: string;
      managerId?: string;
    };
    Designation: {
      id: string;
      title: string;
      code: string;
      departmentId?: string;
      level?: number;
    };
    PayrollRun: {
      id: string;
      periodMonth: number;
      periodYear: number;
      status: 'DRAFT' | 'PROCESSING' | 'APPROVED' | 'PAID' | 'CANCELLED';
      totalGross: number;
      totalNet: number;
      totalDeductions: number;
      currency: string;
      payslipCount?: number;
      approvedById?: string;
      approvedAt?: string;
      createdAt: string;
    };
    Payslip: {
      id: string;
      payrollRunId: string;
      employeeId: string;
      employee?: components['schemas']['Employee'];
      periodMonth: number;
      periodYear: number;
      basicSalary: number;
      grossPay: number;
      netPay: number;
      totalDeductions: number;
      status: string;
    };
    AttendanceRecord: {
      id: string;
      employeeId: string;
      employee?: components['schemas']['Employee'];
      date: string;
      clockInTime?: string;
      clockOutTime?: string;
      totalHours?: number;
      status: 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'ON_LEAVE';
      notes?: string;
    };
    AttendanceCorrection: {
      id: string;
      attendanceId: string;
      employeeId: string;
      employee?: components['schemas']['Employee'];
      requestedClockIn?: string;
      requestedClockOut?: string;
      reason: string;
      status: 'PENDING' | 'APPROVED' | 'REJECTED';
    };
    LeaveRequest: {
      id: string;
      employeeId: string;
      employee?: components['schemas']['Employee'];
      leaveTypeId: string;
      leaveType?: components['schemas']['LeaveType'];
      startDate: string;
      endDate: string;
      totalDays: number;
      reason: string;
      status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
      approvedById?: string;
      approvedAt?: string;
    };
    LeaveBalance: {
      id?: string;
      employeeId: string;
      leaveTypeId: string;
      leaveType?: components['schemas']['LeaveType'];
      allocatedDays: number;
      usedDays: number;
      remainingDays: number;
    };
    LeaveType: {
      id: string;
      name: string;
      code: string;
      defaultDaysPerYear: number;
    };
    Document: {
      id: string;
      title: string;
      fileName: string;
      mimeType: string;
      fileSize: number;
      category: string;
      employeeId?: string;
      uploadedById?: string;
      expiresAt?: string | null;
      requiresAcknowledgement?: boolean;
      acknowledgedAt?: string | null;
      createdAt: string;
    };
    Notification: {
      id: string;
      userId: string;
      title: string;
      message: string;
      isRead: boolean;
      linkUrl?: string;
      createdAt: string;
    };
    AuditLog: {
      id: string;
      actorId?: string;
      action: string;
      entityType: string;
      entityId?: string;
      ip?: string;
      userAgent?: string;
      createdAt: string;
    };
    PaginatedEmployees: {
      items: components['schemas']['Employee'][];
      total: number;
      page: number;
      limit: number;
    };
    PaginatedPayrollRuns: {
      items: components['schemas']['PayrollRun'][];
      total: number;
      page: number;
      limit: number;
    };
    PaginatedPayslips: {
      items: components['schemas']['Payslip'][];
      total: number;
      page: number;
      limit: number;
    };
    PaginatedAttendance: {
      items: components['schemas']['AttendanceRecord'][];
      total: number;
      page: number;
      limit: number;
    };
    PaginatedLeaveRequests: {
      items: components['schemas']['LeaveRequest'][];
      total: number;
      page: number;
      limit: number;
    };
    PaginatedDocuments: {
      items: components['schemas']['Document'][];
      total: number;
      page: number;
      limit: number;
    };
  };
}
