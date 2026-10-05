import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StatutoryPayrollProvider,
  StatutoryPayrollSubmissionRequest,
  StatutorySubmissionReceipt,
  StatutorySubmissionStatus,
} from './statutory-payroll-provider.interface';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SANDBOX provider — FOR INTEGRATION TESTING ONLY. NOT A REAL SUBMISSION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This implementation simulates a statutory payroll provider WITHOUT calling
 * any real tax authority or payroll API. It accepts the submission, returns a
 * SYNTHESISED submission id/reference, and reports ACCEPTED on status
 * checks. Nothing leaves the building.
 *
 * DO NOT use for real filings. A real provider implementation must:
 *  - call the provider's API over TLS with credentials from config/secret
 *    storage (never code),
 *  - return the provider's REAL submission id and reference,
 *  - surface REJECTED/FAILED with the provider's error detail,
 *  - never log payrollIdentifiers (NI numbers, tax codes) in plaintext.
 */
export class SandboxStatutoryPayrollProvider implements StatutoryPayrollProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;
  private readonly logger = new Logger(SandboxStatutoryPayrollProvider.name);
  private readonly submissions = new Map<string, { receipt: StatutorySubmissionReceipt; request: StatutoryPayrollSubmissionRequest }>();

  validateConfig(): void {
    // The sandbox needs no credentials. This method exists so the service
    // can fail closed uniformly for real providers that do.
  }

  async submitPayroll(request: StatutoryPayrollSubmissionRequest): Promise<StatutorySubmissionReceipt> {
    if (!request.employees.length) {
      throw new Error('Sandbox provider: refusing empty submission (no employees)');
    }
    const submissionId = `sandbox-${randomUUID()}`;
    const receipt: StatutorySubmissionReceipt = {
      submissionId,
      provider: this.name,
      status: 'SUBMITTED',
      // Synthesised — clearly namespaced so it can never be mistaken for a
      // real filing reference.
      reference: `SANDBOX-${request.period.year}${String(request.period.month).padStart(2, '0')}-${submissionId.slice(8, 13).toUpperCase()}`,
      submittedAt: new Date().toISOString(),
      sandbox: true,
      detail: 'SANDBOX ONLY: no real filing was made. Do not use for statutory submissions.',
    };
    this.submissions.set(submissionId, { receipt, request });
    this.logger.warn(
      `SANDBOX statutory submission ${submissionId} for run ${request.payrollRunId} — NOT a real filing`,
    );
    return receipt;
  }

  async getSubmissionStatus(submissionId: string): Promise<StatutorySubmissionStatus> {
    const entry = this.submissions.get(submissionId);
    if (!entry) {
      return {
        submissionId,
        provider: this.name,
        status: 'FAILED',
        detail: 'Unknown sandbox submission id (sandbox state is in-memory and resets on restart)',
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      submissionId,
      provider: this.name,
      status: 'ACCEPTED',
      detail: 'SANDBOX ONLY: simulated acceptance. No real filing exists.',
      checkedAt: new Date().toISOString(),
    };
  }
}
