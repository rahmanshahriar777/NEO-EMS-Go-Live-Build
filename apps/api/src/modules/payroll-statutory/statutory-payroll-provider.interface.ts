/**
 * Statutory payroll provider adapter (Phase 3 item 3).
 *
 * This is an ADAPTER INTERFACE only. NEO EMS never computes tax, National
 * Insurance, or statutory deductions itself — that is the provider's job
 * (HMRC-recognised payroll software / RTI submitter). The platform hands the
 * provider the computed payroll figures; the provider files them and reports
 * back submission status.
 *
 * To add a real provider: implement this interface, register it in
 * StatutoryPayrollService's provider map, and set STATUTORY_PAYROLL_PROVIDER
 * to its name. Never put provider credentials in code — config only.
 */

export interface StatutoryEmployeePay {
  employeeId: string;
  employeeNumber: string;
  /** Figures as computed by the payroll worker (single-compute rule). */
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  /** Provider-specific payroll identifiers (tax code, NI number, …). These
   *  come from the employee extended profile (Phase 2 item 3, worker 2) and
   *  are passed through opaquely — never logged in plaintext. */
  payrollIdentifiers?: Record<string, string>;
}

export interface StatutoryPayrollSubmissionRequest {
  payrollRunId: string;
  period: { month: number; year: number };
  submittedByUserId: string;
  currency: string;
  employees: StatutoryEmployeePay[];
  totals: { grossPay: number; totalDeductions: number; netPay: number };
}

export type StatutorySubmissionState =
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'PENDING'
  | 'FAILED';

export interface StatutorySubmissionReceipt {
  /** Provider-side submission id. */
  submissionId: string;
  provider: string;
  status: StatutorySubmissionState;
  /** Provider reference (e.g. FPS submission reference). Never fabricated
   *  for real providers — only the sandbox synthesises one. */
  reference?: string;
  submittedAt: string;
  /** True only for the sandbox implementation. */
  sandbox: boolean;
  detail?: string;
}

export interface StatutorySubmissionStatus {
  submissionId: string;
  provider: string;
  status: StatutorySubmissionState;
  detail?: string;
  checkedAt: string;
}

export interface StatutoryPayrollProvider {
  /** Config name, e.g. 'sandbox'. Matched against STATUTORY_PAYROLL_PROVIDER. */
  readonly name: string;
  /** Must be true for any non-production implementation. */
  readonly isSandbox: boolean;
  /** Fail-closed: throw when required config is missing/invalid. */
  validateConfig(): void;
  submitPayroll(request: StatutoryPayrollSubmissionRequest): Promise<StatutorySubmissionReceipt>;
  getSubmissionStatus(submissionId: string): Promise<StatutorySubmissionStatus>;
}
