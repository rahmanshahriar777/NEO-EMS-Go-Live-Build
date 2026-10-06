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
  '/recruitment/vacancies': {
    get: {
      parameters: { query?: { status?: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['Vacancy'][] } } };
    };
    post: {
      requestBody: { content: { 'application/json': components['schemas']['CreateVacancyDto'] } };
      responses: { 201: { content: { 'application/json': components['schemas']['Vacancy'] } } };
    };
  };
  '/recruitment/candidates': {
    post: {
      requestBody: { content: { 'application/json': components['schemas']['CreateCandidateDto'] } };
      responses: { 201: { content: { 'application/json': components['schemas']['Candidate'] } } };
    };
  };
  '/recruitment/vacancies/{id}/candidates': {
    get: {
      parameters: { path: { id: string }; query?: { stage?: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['Candidate'][] } } };
    };
  };
  '/recruitment/candidates/{id}/stage': {
    patch: {
      parameters: { path: { id: string } };
      requestBody: { content: { 'application/json': components['schemas']['UpdateCandidateStageDto'] } };
      responses: { 200: { content: { 'application/json': components['schemas']['Candidate'] } } };
    };
  };
  '/recruitment/candidates/{id}/offers': {
    post: {
      parameters: { path: { id: string } };
      requestBody: { content: { 'application/json': components['schemas']['CreateOfferDto'] } };
      responses: { 201: { content: { 'application/json': components['schemas']['Offer'] } } };
    };
  };
  '/recruitment/offers/{id}/accept': {
    post: {
      parameters: { path: { id: string } };
      responses: { 200: { content: { 'application/json': { success: boolean; employeeId: string } } } };
    };
  };
  '/onboarding/checklists': {
    get: {
      parameters: { query?: { employeeId?: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['OnboardingChecklist'][] } } };
    };
    post: {
      requestBody: { content: { 'application/json': components['schemas']['CreateChecklistDto'] } };
      responses: { 201: { content: { 'application/json': components['schemas']['OnboardingChecklist'] } } };
    };
  };
  '/onboarding/checklists/{id}': {
    get: {
      parameters: { path: { id: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['OnboardingChecklist'] } } };
    };
  };
  '/onboarding/tasks/{id}/assign': {
    patch: {
      parameters: { path: { id: string } };
      requestBody: { content: { 'application/json': { ownerUserId: string } } };
      responses: { 200: { content: { 'application/json': components['schemas']['OnboardingTask'] } } };
    };
  };
  '/onboarding/tasks/{id}/complete': {
    patch: {
      parameters: { path: { id: string } };
      requestBody: { content: { 'application/json': { note?: string; documentId?: string } } };
      responses: { 200: { content: { 'application/json': components['schemas']['OnboardingTask'] } } };
    };
  };
  '/reports/{type}': {
    get: {
      parameters: {
        path: { type: string };
        query?: { format?: 'csv' | 'xlsx' | 'pdf'; from?: string; to?: string; departmentId?: string };
      };
      responses: { 200: { content: { 'application/octet-stream': any } } };
    };
  };
  '/reports/adhoc': {
    post: {
      requestBody: {
        content: {
          'application/json': {
            entity: 'employees' | 'leaves' | 'attendance' | 'payroll';
            filters?: Record<string, any>;
            limit?: number;
          };
        };
      };
      responses: { 200: { content: { 'application/json': any[] } } };
    };
  };
  '/reports/warehouse/{entity}': {
    get: {
      parameters: { path: { entity: string } };
      responses: { 200: { content: { 'application/json': any } } };
    };
  };
  '/integrations/ical-token': {
    get: {
      responses: { 200: { content: { 'application/json': { token: string; path: string } } } };
    };
  };
  '/integrations/ical/{token}': {
    get: {
      parameters: { path: { token: string } };
      responses: { 200: { content: { 'text/calendar': string } } };
    };
  };
  '/integrations/accounting/export': {
    get: {
      parameters: { query: { payrollRunId: string } };
      responses: { 200: { content: { 'text/csv': string } } };
    };
  };
  '/integrations/alert': {
    post: {
      requestBody: { content: { 'application/json': { title: string; message: string; linkUrl?: string } } };
      responses: { 200: { content: { 'application/json': { slack?: any; teams?: any } } } };
    };
  };
  '/integrations/hris/import': {
    post: {
      requestBody: {
        content: {
          'application/json': {
            employees: Array<{
              firstName: string;
              lastName: string;
              email: string;
              departmentCode?: string;
              designationTitle?: string;
              phone?: string;
            }>;
          };
        };
      };
      responses: {
        200: {
          content: {
            'application/json': { imported: number; updated: number; failed: number; errors: string[] };
          };
        };
      };
    };
  };
  '/payroll-statutory/submissions': {
    get: {
      parameters: { query?: { page?: number; limit?: number } };
      responses: { 200: { content: { 'application/json': components['schemas']['PaginatedStatutorySubmissions'] } } };
    };
  };
  '/payroll-statutory/submissions/{submissionId}': {
    get: {
      parameters: { path: { submissionId: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['StatutorySubmissionStatus'] } } };
    };
  };
  '/payroll-statutory/runs/{runId}/submit': {
    post: {
      parameters: { path: { runId: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['StatutoryReceipt'] } } };
    };
  };
  '/gdpr/export': {
    get: {
      parameters: { query?: { attendancePage?: string; attendanceLimit?: string } };
      responses: { 200: { content: { 'application/json': any } } };
    };
  };
  '/gdpr/erasure-requests': {
    get: {
      parameters: { query?: { page?: number; limit?: number; status?: string } };
      responses: { 200: { content: { 'application/json': components['schemas']['PaginatedErasureRequests'] } } };
    };
    post: {
      requestBody: { content: { 'application/json': { reason: string; preferredDate?: string } } };
      responses: { 201: { content: { 'application/json': components['schemas']['ErasureRequest'] } } };
    };
  };
  '/gdpr/erasure-requests/{id}/review': {
    post: {
      parameters: { path: { id: string } };
      requestBody: { content: { 'application/json': { decision: 'APPROVE' | 'REJECT'; reason?: string } } };
      responses: { 200: { content: { 'application/json': components['schemas']['ErasureRequest'] } } };
    };
  };
  '/gdpr/retention/schedule': {
    get: {
      responses: { 200: { content: { 'application/json': components['schemas']['RetentionSchedule'] } } };
    };
  };
  '/gdpr/retention/preview': {
    get: {
      responses: { 200: { content: { 'application/json': any } } };
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
    Vacancy: {
      id: string;
      title: string;
      description?: string | null;
      departmentId?: string | null;
      designationId?: string | null;
      status: 'OPEN' | 'ON_HOLD' | 'CLOSED';
      postedAt: string;
      closedAt?: string | null;
      _count?: { candidates: number };
    };
    CreateVacancyDto: {
      title: string;
      departmentId?: string;
      designationId?: string;
      description?: string;
      status?: 'OPEN' | 'ON_HOLD' | 'CLOSED';
    };
    Candidate: {
      id: string;
      vacancyId: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string | null;
      stage: 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
      notes?: any;
      employeeId?: string | null;
      createdAt: string;
      offers?: components['schemas']['Offer'][];
    };
    CreateCandidateDto: {
      vacancyId: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      resumeDocumentId?: string;
    };
    UpdateCandidateStageDto: {
      stage: 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
      note?: string;
    };
    Offer: {
      id: string;
      candidateId: string;
      status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
      startDate?: string | null;
      salaryAmount?: number | null;
      terms?: string | null;
      createdAt: string;
    };
    CreateOfferDto: {
      startDate: string;
      salaryAmount?: number;
      terms?: string;
    };
    OnboardingChecklist: {
      id: string;
      employeeId: string;
      kind: 'ONBOARDING' | 'OFFBOARDING';
      status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
      referenceDate?: string | null;
      createdById?: string | null;
      createdAt: string;
      tasks: components['schemas']['OnboardingTask'][];
    };
    OnboardingTask: {
      id: string;
      checklistId: string;
      title: string;
      description?: string | null;
      ownerRole: string;
      ownerUserId?: string | null;
      dueDate?: string | null;
      status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED';
      completedAt?: string | null;
      completedById?: string | null;
      note?: string | null;
      documentId?: string | null;
    };
    CreateChecklistDto: {
      employeeId: string;
      kind: 'ONBOARDING' | 'OFFBOARDING';
      referenceDate?: string;
      tasks?: Array<{
        title: string;
        description?: string;
        ownerRole?: string;
        dueDayOffset?: number;
      }>;
    };
    StatutorySubmission: {
      submissionId: string;
      provider: string;
      sandbox: boolean;
      status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'PENDING';
      reference?: string;
      payrollRunId: string;
      period: { month: number; year: number };
      employeeCount: number;
      totals: { grossPay: number; totalDeductions: number; netPay: number };
      submittedAt: string;
    };
    PaginatedStatutorySubmissions: {
      items: components['schemas']['StatutorySubmission'][];
      meta: { total: number; page: number; limit: number; totalPages: number };
    };
    StatutorySubmissionStatus: {
      submissionId: string;
      status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'PENDING';
      provider: string;
      checkedAt?: string;
    };
    StatutoryReceipt: {
      submissionId: string;
      provider: string;
      status: string;
      reference?: string;
      sandbox: boolean;
      submittedAt: string;
    };
    ErasureRequest: {
      id: string;
      employeeId: string;
      status: 'PENDING' | 'APPROVED' | 'REJECTED';
      reason: string;
      preferredDate?: string | null;
      reviewedByUserId?: string | null;
      reviewDecision?: string | null;
      reviewReason?: string | null;
      requestedAt: string;
      reviewedAt?: string | null;
    };
    PaginatedErasureRequests: {
      items: components['schemas']['ErasureRequest'][];
      meta: { total: number; page: number; limit: number };
    };
    RetentionSchedule: {
      version: string;
      signedOff: boolean;
      signoffEnv: string;
      rules: components['schemas']['RetentionRule'][];
    };
    RetentionRule: {
      entity: string;
      retentionDays: number;
      basis: string;
      purgeable: boolean;
    };
  };
}
