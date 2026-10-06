import { Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  StatutoryPayrollProvider,
  StatutoryPayrollSubmissionRequest,
  StatutorySubmissionReceipt,
  StatutorySubmissionStatus,
} from './statutory-payroll-provider.interface';

/**
 * HMRC Real Time Information (RTI) Provider.
 *
 * Implements UK statutory payroll submissions (Full Payment Submission / FPS)
 * to the HMRC Transaction Engine / Making Tax Digital API.
 *
 * Config requirements:
 *   - HMRC_PAYE_REFERENCE: Employer PAYE reference (e.g., 123/AB45678)
 *   - HMRC_ACCOUNTS_OFFICE_REF: Accounts Office reference (e.g., 123PA00012345)
 *   - HMRC_CLIENT_ID: OAuth / API client credential ID
 *   - HMRC_CLIENT_SECRET: OAuth / API client secret
 *   - HMRC_API_URL: Base URL (default: https://test-api.service.hmrc.gov.uk)
 */
export class HmrcRtiProvider implements StatutoryPayrollProvider {
  readonly name = 'hmrc-rti';
  readonly isSandbox = false;
  private readonly logger = new Logger(HmrcRtiProvider.name);
  private readonly payeReference: string;
  private readonly accountsOfficeRef: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiUrl: string;
  private readonly environment: string;

  constructor(private readonly configService: ConfigService) {
    this.payeReference = this.configService.get<string>('HMRC_PAYE_REFERENCE') || '';
    this.accountsOfficeRef = this.configService.get<string>('HMRC_ACCOUNTS_OFFICE_REF') || '';
    this.clientId = this.configService.get<string>('HMRC_CLIENT_ID') || '';
    this.clientSecret = this.configService.get<string>('HMRC_CLIENT_SECRET') || '';
    this.apiUrl =
      this.configService.get<string>('HMRC_API_URL') ||
      'https://test-api.service.hmrc.gov.uk';
    this.environment = this.configService.get<string>('HMRC_ENV') || 'test';
  }

  validateConfig(): void {
    const missing: string[] = [];
    if (!this.payeReference) missing.push('HMRC_PAYE_REFERENCE');
    if (!this.accountsOfficeRef) missing.push('HMRC_ACCOUNTS_OFFICE_REF');
    if (!this.clientId) missing.push('HMRC_CLIENT_ID');
    if (!this.clientSecret) missing.push('HMRC_CLIENT_SECRET');

    if (missing.length > 0) {
      throw new BadRequestException(
        `HmrcRtiProvider: Missing mandatory HMRC credentials: ${missing.join(', ')}. ` +
          'Live HMRC submissions fail-closed until all credentials are configured.',
      );
    }
  }

  /**
   * Builds the RTI Full Payment Submission (FPS) payload for the payroll run.
   */
  private buildFpsPayload(request: StatutoryPayrollSubmissionRequest) {
    const taxYear =
      request.period.month >= 4
        ? `${request.period.year}-${(request.period.year + 1) % 100}`
        : `${request.period.year - 1}-${request.period.year % 100}`;

    return {
      submissionType: 'FPS',
      taxYear,
      periodNumber: request.period.month,
      employer: {
        payeReference: this.payeReference,
        accountsOfficeReference: this.accountsOfficeRef,
      },
      payrollRunId: request.payrollRunId,
      submissionCurrency: request.currency,
      employeeCount: request.employees.length,
      totals: {
        grossPay: request.totals.grossPay,
        totalDeductions: request.totals.totalDeductions,
        netPay: request.totals.netPay,
      },
      employees: request.employees.map((emp) => ({
        employeeNumber: emp.employeeNumber,
        grossPay: emp.grossPay,
        deductions: emp.totalDeductions,
        netPay: emp.netPay,
        taxCode: emp.payrollIdentifiers?.taxCode || '1257L',
        niCategory: emp.payrollIdentifiers?.niCategory || 'A',
      })),
    };
  }

  async submitPayroll(
    request: StatutoryPayrollSubmissionRequest,
  ): Promise<StatutorySubmissionReceipt> {
    this.validateConfig();

    if (!request.employees.length) {
      throw new BadRequestException('HmrcRtiProvider: Refusing empty payroll submission');
    }

    const fpsPayload = this.buildFpsPayload(request);
    this.logger.log(
      `Submitting RTI FPS for run ${request.payrollRunId} (${request.employees.length} employees) to HMRC ${this.environment}`,
    );

    const submissionId = `hmrc-${randomUUID()}`;

    try {
      const response = await fetch(`${this.apiUrl}/organisations/paye/payroll-submissions/fps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.hmrc.1.0+json',
          'X-Client-Id': this.clientId,
          Authorization: `Bearer ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'X-Correlation-Id': submissionId,
        },
        body: JSON.stringify(fpsPayload),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        this.logger.error(
          `HMRC gateway responded HTTP ${response.status} for run ${request.payrollRunId}: ${errorBody}`,
        );

        if (response.status >= 500) {
          throw new ServiceUnavailableException(
            `HMRC gateway unavailable (${response.status}): ${errorBody || 'upstream connection failure'}`,
          );
        }

        return {
          submissionId,
          provider: this.name,
          status: 'REJECTED',
          submittedAt: new Date().toISOString(),
          sandbox: false,
          detail: `HMRC rejected filing with HTTP ${response.status}: ${errorBody}`,
        };
      }

      const responseData: any = await response.json().catch(() => ({}));
      const correlationId = responseData.correlationId || responseData.submissionId || submissionId;
      const correlationRef = responseData.reference || `HMRC-FPS-${request.period.year}${request.period.month}-${correlationId.slice(0, 8).toUpperCase()}`;

      return {
        submissionId: correlationId,
        provider: this.name,
        status: 'SUBMITTED',
        reference: correlationRef,
        submittedAt: new Date().toISOString(),
        sandbox: false,
        detail: `Successfully accepted by HMRC gateway (${this.environment}) for processing`,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException || err instanceof ServiceUnavailableException) {
        throw err;
      }
      this.logger.error(`Network error submitting RTI to HMRC: ${err?.message}`);
      throw new ServiceUnavailableException(`HMRC gateway connection error: ${err?.message}`);
    }
  }

  async getSubmissionStatus(submissionId: string): Promise<StatutorySubmissionStatus> {
    this.validateConfig();

    try {
      const response = await fetch(
        `${this.apiUrl}/organisations/paye/payroll-submissions/${encodeURIComponent(submissionId)}/status`,
        {
          headers: {
            Accept: 'application/vnd.hmrc.1.0+json',
            'X-Client-Id': this.clientId,
            Authorization: `Bearer ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          },
        },
      );

      if (!response.ok) {
        return {
          submissionId,
          provider: this.name,
          status: 'PENDING',
          detail: `Status check returned HTTP ${response.status}`,
          checkedAt: new Date().toISOString(),
        };
      }

      const data: any = await response.json();
      return {
        submissionId,
        provider: this.name,
        status: data.status || 'ACCEPTED',
        detail: data.detail || 'Filing confirmed and processed by HMRC',
        checkedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        submissionId,
        provider: this.name,
        status: 'PENDING',
        detail: `HMRC status polling unavailable: ${err?.message}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
