import { renderPdf } from '../reports/export/pdf';

/**
 * Payslip PDF renderer (Phase 2 item 4).
 *
 * Renders a payslip from STORED payslip data only — this module never computes
 * payroll math (single-compute rule: the worker's payroll processor owns all
 * gross/deduction/net computation). Amounts are displayed exactly as persisted.
 */

export interface PayslipPdfInput {
  employeeName: string;
  employeeNumber: string;
  department?: string | null;
  designation?: string | null;
  periodLabel: string;
  disbursementDate?: string | null;
  status: string;
  currency: string;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  breakdown: Array<{ component: string; type: string; amount: number | string }>;
}

function money(amount: number | string, currency: string): string {
  const n = Number(amount);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(amount);
  return `${currency} ${formatted}`;
}

export function renderPayslipPdf(input: PayslipPdfInput): Buffer {
  const earnings = input.breakdown.filter((b) => b.type === 'EARNING');
  const deductions = input.breakdown.filter((b) => b.type !== 'EARNING');

  return renderPdf({
    title: 'Payslip',
    subtitle: `Pay period: ${input.periodLabel}`,
    sections: [
      {
        heading: 'Employee',
        keyValues: [
          { label: 'Name', value: input.employeeName },
          { label: 'Employee number', value: input.employeeNumber },
          ...(input.department ? [{ label: 'Department', value: input.department }] : []),
          ...(input.designation ? [{ label: 'Designation', value: input.designation }] : []),
          { label: 'Status', value: input.status },
          ...(input.disbursementDate
            ? [{ label: 'Disbursement date', value: input.disbursementDate }]
            : []),
        ],
      },
      {
        heading: 'Earnings',
        table: {
          headers: ['Component', 'Amount'],
          rows: earnings.map((b) => [b.component, money(b.amount, input.currency)]),
        },
      },
      {
        heading: 'Deductions',
        table: {
          headers: ['Component', 'Amount'],
          rows:
            deductions.length > 0
              ? deductions.map((b) => [b.component, money(b.amount, input.currency)])
              : [['—', '—']],
        },
      },
      {
        heading: 'Summary',
        keyValues: [
          { label: 'Gross pay', value: money(input.grossPay, input.currency) },
          { label: 'Total deductions', value: money(input.totalDeductions, input.currency) },
          { label: 'Net pay', value: money(input.netPay, input.currency) },
        ],
        notes: [
          'This is a computer-generated payslip rendered from stored payroll records.',
          'Payroll computation is performed once by the payroll worker; this document only presents the stored result.',
        ],
      },
    ],
    footer: 'NEO EMS — Payroll',
  });
}
