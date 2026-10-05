'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Banknote,
  Plus,
  Search,
  X,
  Calendar,
  TrendingUp,
  ShieldCheck,
  ArrowUpRight,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { usePayrollQuery, payrollKeys } from '../../../lib/queries';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { PaginationControls } from '../../../components/ui/pagination';
import { SkeletonTable } from '../../../components/ui/skeleton';
import { useAuth } from '../../../context/auth-context';
import { useFocusTrap } from '../../../hooks/use-focus-trap';
import { formatCurrency, currencyLabel } from '../../../lib/date-utils';
import { SystemRole } from '@ems/shared';
import '../../../styles/payroll.css';

interface Payslip {
  id: string;
  periodMonth: number;
  periodYear: number;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  status: string;
  employee?: {
    id?: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
    designation?: { title: string };
    department?: { name: string };
  };
  breakdown?: Array<{
    component: string;
    type: 'EARNING' | 'DEDUCTION';
    amount: number;
  }>;
}

interface PayrollRun {
  id: string;
  month: number;
  year: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
  status: string;
  department?: { name: string };
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export default function PayrollPage() {
  const { user, hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [selectedPayslip, setSelectedPayslip] = useState<Payslip | null>(null);
  const [showRunModal, setShowRunModal] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PAID' | 'PENDING'>('ALL');

  const PAGE_SIZE = 15;

  const canViewRuns = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR);
  const { data, isPending: loading, error: queryError, refetch } = usePayrollQuery(page, PAGE_SIZE, canViewRuns);
  const payrollRuns: PayrollRun[] = data?.runs || [];
  const payslips: Payslip[] = data?.payslips.items || [];
  const total = data?.payslips.total || 0;
  const error = queryError ? (queryError as Error).message || 'Failed to load payroll data.' : null;

  // Cycle Modal State
  const [runMonth, setRunMonth] = useState<number>(new Date().getMonth() + 1);
  const [runYear, setRunYear] = useState<number>(new Date().getFullYear());
  const [runningPayroll, setRunningPayroll] = useState(false);

  // Run lifecycle actions (Phase 2 item 4: approve/disburse/corrections)
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Correction request modal (payslip-level)
  const [correctSlip, setCorrectSlip] = useState<Payslip | null>(null);
  const [correctReason, setCorrectReason] = useState('');
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);

  const payslipModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(payslipModalRef, { isActive: Boolean(selectedPayslip), onEscape: () => setSelectedPayslip(null) });

  const correctModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(correctModalRef, { isActive: Boolean(correctSlip), onEscape: () => setCorrectSlip(null) });

  const runModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(runModalRef, { isActive: showRunModal, onEscape: () => setShowRunModal(false) });

  const handleRunPayroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunningPayroll(true);
    setRunError(null);
    try {
      await api.post('/payroll/runs', { month: Number(runMonth), year: Number(runYear) });
      setShowRunModal(false);
      await queryClient.invalidateQueries({ queryKey: payrollKeys.all });
    } catch (err: any) {
      // Keep the modal open and show the error inline; no payroll was generated.
      setRunError(err?.message || 'Failed to generate payroll cycle.');
    } finally {
      setRunningPayroll(false);
    }
  };

  // Filtered payslips
  const filteredPayslips = useMemo(() => {
    return payslips.filter((slip) => {
      const matchStatus = statusFilter === 'ALL' || slip.status === statusFilter;
      const q = search.toLowerCase().trim();
      const empName = `${slip.employee?.firstName || ''} ${slip.employee?.lastName || ''}`.toLowerCase();
      const empCode = (slip.employee?.employeeNumber || '').toLowerCase();
      const period = `${slip.periodMonth}/${slip.periodYear}`.toLowerCase();
      const matchSearch = !q || empName.includes(q) || empCode.includes(q) || period.includes(q);
      return matchStatus && matchSearch;
    });
  }, [payslips, statusFilter, search]);

  const totalDisbursed = useMemo(() => {
    return payslips.reduce((acc, curr) => acc + Number(curr.netPay || 0), 0);
  }, [payslips]);

  const totalDeductions = useMemo(() => {
    return payslips.reduce((acc, curr) => acc + Number(curr.totalDeductions || 0), 0);
  }, [payslips]);

  const activeCycle = payrollRuns[0] || null;
  const canApprove = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const handleApproveRun = async (run: PayrollRun) => {
    if (!window.confirm(`Approve the ${MONTH_NAMES[(run.month || 1) - 1]} ${run.year} payroll run? Approval locks the run for disbursement.`)) return;
    setActionBusy(run.id);
    setActionError(null);
    try {
      // Maker/checker: the API rejects when approver === creator (403).
      await api.patch(`/payroll/runs/${run.id}/approve`, {});
      await queryClient.invalidateQueries({ queryKey: payrollKeys.all });
    } catch (err: any) {
      setActionError(err?.message || 'Could not approve this run.');
    } finally {
      setActionBusy(null);
    }
  };

  const handleDisburseRun = async (run: PayrollRun) => {
    if (!window.confirm(`Disburse ${formatCurrency(run.totalNet)} for ${MONTH_NAMES[(run.month || 1) - 1]} ${run.year}? This records the disbursement date and is idempotent.`)) return;
    setActionBusy(run.id);
    setActionError(null);
    try {
      // Idempotent: safe to retry; the API records disbursementDate.
      await api.post(`/payroll/runs/${run.id}/disburse`, {});
      await queryClient.invalidateQueries({ queryKey: payrollKeys.all });
    } catch (err: any) {
      setActionError(err?.message || 'Could not disburse this run.');
    } finally {
      setActionBusy(null);
    }
  };

  const handleBankCsv = async (run: PayrollRun) => {
    setActionBusy(run.id);
    setActionError(null);
    try {
      // Bank payment file (Phase 2 item 4). Endpoint: worker 3/4.
      await api.downloadFile(
        `/payroll/runs/${run.id}/bank-csv`,
        `bank-payments-${run.year}-${String(run.month).padStart(2, '0')}.csv`,
      );
    } catch (err: any) {
      setActionError(
        `Bank CSV not available: ${err?.message || 'download failed'}. The /payroll/runs/:id/bank-csv endpoint is not deployed yet.`,
      );
    } finally {
      setActionBusy(null);
    }
  };

  const handleCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctSlip) return;
    setCorrectBusy(true);
    setCorrectError(null);
    try {
      // Payroll correction request (Phase 2 item 4). Endpoint: worker 3/4.
      await api.post(`/payroll/payslips/${correctSlip.id}/corrections`, {
        reason: correctReason,
      });
      setCorrectSlip(null);
      setCorrectReason('');
      await queryClient.invalidateQueries({ queryKey: payrollKeys.all });
    } catch (err: any) {
      setCorrectError(
        err?.message || 'Could not submit the correction. The corrections endpoint is not deployed yet.',
      );
    } finally {
      setCorrectBusy(false);
    }
  };

  return (
    <DashboardLayout title="Compensation & Payroll Runs">
      <div className="payroll-editorial-wrapper">
        <div className="pay-page">
          {/* Header Section */}
          <header className="pay-header">
            <div className="pay-header-top">
              <div>
                <h1 className="pay-title">Compensation & Payroll Runs</h1>
                <p className="pay-subtitle">
                  Decimal-safe monetary calculations, itemized salary disbursements, and compliance audits across Neoteric Digital.
                </p>
              </div>

              <div className="pay-header-actions">
                <div className="pay-stat-pill">
                  <span>Currency</span>
                  <span className="count">{currencyLabel()}</span>
                </div>

                {hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN) && (
                  <button onClick={() => setShowRunModal(true)} className="pay-btn-primary">
                    <Plus className="w-4 h-4" />
                    <span>Run Payroll Cycle</span>
                  </button>
                )}
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: '16px' }}>
                <ErrorBanner
                  resource="payroll data"
                  detail={error}
                  onRetry={() => refetch()}
                  retrying={loading}
                />
              </div>
            )}

            {/* Quick 4-Stat Metrics Row — real API data only */}
            <div className="pay-quick-stats">
              <div className="pay-quick-stat-card">
                <div>
                  <div className="pay-quick-stat-label">Net Disbursed (Loaded)</div>
                  <div className="pay-quick-stat-value">
                    {error ? '—' : formatCurrency(totalDisbursed)}
                  </div>
                </div>
                <div className="pay-quick-stat-icon">
                  <Banknote className="w-5 h-5" />
                </div>
              </div>

              <div className="pay-quick-stat-card">
                <div>
                  <div className="pay-quick-stat-label">Active Cycle</div>
                  <div className="pay-quick-stat-value" style={{ fontSize: '16px' }}>
                    {error || !activeCycle
                      ? '—'
                      : `Month ${activeCycle.month}, ${activeCycle.year} • ${activeCycle.status}`}
                  </div>
                </div>
                <div className="pay-quick-stat-icon">
                  <Calendar className="w-5 h-5" />
                </div>
              </div>

              <div className="pay-quick-stat-card">
                <div>
                  <div className="pay-quick-stat-label">Average Compensation</div>
                  <div className="pay-quick-stat-value">
                    {error || payslips.length === 0
                      ? '—'
                      : formatCurrency(totalDisbursed / payslips.length)}
                  </div>
                </div>
                <div className="pay-quick-stat-icon">
                  <TrendingUp className="w-5 h-5" />
                </div>
              </div>

              <div className="pay-quick-stat-card">
                <div>
                  <div className="pay-quick-stat-label">Total Deductions (Loaded)</div>
                  <div className="pay-quick-stat-value">
                    {error ? '—' : formatCurrency(totalDeductions)}
                  </div>
                </div>
                <div className="pay-quick-stat-icon">
                  <ShieldCheck className="w-5 h-5" />
                </div>
              </div>
            </div>
          </header>

          {/* Payroll Runs — approve / disburse / bank CSV / corrections (Phase 2 item 4) */}
          {canApprove && (
            <section style={{ marginTop: '20px' }}>
              <div className="section-header" style={{ marginBottom: '12px' }}>
                <span className="section-title">Payroll Runs</span>
                <span style={{ fontSize: '11px', color: 'var(--pay-text-tertiary)', fontFamily: 'var(--pay-font-mono)' }}>
                  Approval is maker/checker: the creator cannot approve their own run (403).
                </span>
              </div>

              {actionError && (
                <div
                  role="alert"
                  style={{
                    marginBottom: '12px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(244, 63, 94, 0.08)',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                    color: '#f43f5e',
                    fontSize: '12.5px',
                  }}
                >
                  {actionError}{' '}
                  <button onClick={() => setActionError(null)} style={{ textDecoration: 'underline', fontWeight: 600, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
                    Dismiss
                  </button>
                </div>
              )}

              {payrollRuns.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--pay-text-tertiary)', padding: '12px 0' }}>
                  {error ? 'Runs could not be loaded.' : 'No payroll runs yet — create one with “Run Payroll Cycle”.'}
                </div>
              ) : (
                <div className="pay-table-wrapper" style={{ marginBottom: '8px' }}>
                  <table className="pay-table">
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th>Status</th>
                        <th>Gross</th>
                        <th>Deductions</th>
                        <th>Net</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payrollRuns.map((run) => (
                        <tr key={run.id}>
                          <td className="pay-period-col">
                            {MONTH_NAMES[(run.month || 1) - 1]} {run.year}
                          </td>
                          <td>
                            <span
                              className={`pay-status-badge ${
                                run.status === 'PAID' || run.status === 'DISBURSED' || run.status === 'APPROVED'
                                  ? 'pay-status-paid'
                                  : 'pay-status-pending'
                              }`}
                            >
                              {run.status}
                            </span>
                          </td>
                          <td className="pay-amount-mono">{formatCurrency(run.totalGross)}</td>
                          <td className="pay-amount-deduct">-{formatCurrency(run.totalDeductions)}</td>
                          <td className="pay-amount-net">{formatCurrency(run.totalNet)}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {(run.status === 'DRAFT' || run.status === 'PENDING') && (
                              <button
                                onClick={() => handleApproveRun(run)}
                                disabled={actionBusy === run.id}
                                className="pay-action-btn"
                                style={{ marginRight: '8px' }}
                              >
                                <span>{actionBusy === run.id ? 'Approving…' : 'Approve'}</span>
                              </button>
                            )}
                            {run.status === 'APPROVED' && (
                              <button
                                onClick={() => handleDisburseRun(run)}
                                disabled={actionBusy === run.id}
                                className="pay-action-btn"
                                style={{ marginRight: '8px' }}
                              >
                                <span>{actionBusy === run.id ? 'Disbursing…' : 'Disburse'}</span>
                              </button>
                            )}
                            <button
                              onClick={() => handleBankCsv(run)}
                              disabled={actionBusy === run.id}
                              className="pay-action-btn"
                              title="Download bank payment file (CSV)"
                            >
                              <span>{actionBusy === run.id ? 'Working…' : 'Bank CSV'}</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* Search Toolbar & Tabs */}
          <div className="pay-toolbar">
            <div className="pay-search-container">
              <Search className="pay-search-icon" />
              <input
                type="text"
                id="payroll-search"
                aria-label="Search payslips"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search payslips by employee, ID, or pay period..."
                className="pay-search-input"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--pay-text-tertiary)',
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="pay-filter-tabs">
              <button
                onClick={() => setStatusFilter('ALL')}
                className={`pay-tab-btn ${statusFilter === 'ALL' ? 'active' : ''}`}
              >
                All Payslips ({payslips.length})
              </button>
              <button
                onClick={() => setStatusFilter('PAID')}
                className={`pay-tab-btn ${statusFilter === 'PAID' ? 'active' : ''}`}
              >
                Disbursed / Paid
              </button>
              <button
                onClick={() => setStatusFilter('PENDING')}
                className={`pay-tab-btn ${statusFilter === 'PENDING' ? 'active' : ''}`}
              >
                Pending
              </button>
            </div>
          </div>

          {/* Table View */}
          {loading ? (
            <SkeletonTable rows={8} columns={6} />
          ) : filteredPayslips.length === 0 ? (
            <div style={{
              padding: '64px 20px',
              textAlign: 'center',
              background: 'var(--pay-surface)',
              border: '1px solid var(--pay-border)',
              borderRadius: 'var(--pay-radius-lg)',
              boxShadow: 'var(--pay-shadow-sm)',
            }}>
              <Banknote className="w-8 h-8 mx-auto text-slate-400 mb-2" />
              <h3 style={{ fontFamily: 'var(--pay-font-serif)', fontSize: '20px', color: 'var(--pay-text-primary)' }}>
                No Payslip Records Found
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--pay-text-secondary)', marginTop: '4px' }}>
                There are no salary records matching your search query or selected tab.
              </p>
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="pay-btn-primary"
                  style={{ marginTop: '16px', display: 'inline-flex' }}
                >
                  Reset Query
                </button>
              )}
            </div>
          ) : (
            <div className="pay-table-wrapper">
              <table className="pay-table">
                <thead>
                  <tr>
                    <th>Pay Period</th>
                    <th>Employee</th>
                    <th>Gross Earnings</th>
                    <th>Deductions</th>
                    <th>Net Disbursed</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPayslips.map((slip) => (
                    <tr key={slip.id}>
                      <td className="pay-period-col">
                        {slip.periodMonth ? `Month ${slip.periodMonth}/${slip.periodYear}` : '—'}
                      </td>

                      <td>
                        <div className="pay-table-user">
                          <div className="pay-user-avatar">
                            {slip.employee?.firstName?.[0] || 'E'}
                            {slip.employee?.lastName?.[0] || ''}
                          </div>
                          <div>
                            <div className="pay-user-name">
                              {slip.employee?.firstName} {slip.employee?.lastName}
                            </div>
                            <span className="pay-user-code">
                              {slip.employee?.employeeNumber || '—'}
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="pay-amount-mono">
                        {formatCurrency(slip.grossPay)}
                      </td>

                      <td className="pay-amount-deduct">
                        -{formatCurrency(slip.totalDeductions)}
                      </td>

                      <td className="pay-amount-net">
                        {formatCurrency(slip.netPay)}
                      </td>

                      <td>
                        <span
                          className={`pay-status-badge ${
                            slip.status === 'PAID' || slip.status === 'APPROVED'
                              ? 'pay-status-paid'
                              : 'pay-status-pending'
                          }`}
                        >
                          {slip.status}
                        </span>
                      </td>

                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => setSelectedPayslip(slip)}
                          className="pay-action-btn"
                          style={{ marginRight: '8px' }}
                        >
                          <span>View Payslip</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                        {canApprove && (
                          <button
                            onClick={() => {
                              setCorrectSlip(slip);
                              setCorrectReason('');
                              setCorrectError(null);
                            }}
                            className="pay-action-btn"
                            title="Request a payroll correction"
                          >
                            <span>Correct</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination — wired to ?page&limit and the API's {items,total} response */}
          <div style={{ marginTop: '16px' }}>
            <PaginationControls
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={(p) => setPage(p)}
            />
          </div>
        </div>
      </div>

      {/* Official Payslip Modal */}
      {selectedPayslip && (
        <div className="pay-modal-overlay" onClick={() => setSelectedPayslip(null)}>
          <div
            ref={payslipModalRef}
            className="pay-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pay-modal-title"
          >
            <div className="pay-modal-header">
              <div className="pay-brand-header">
                <div className="pay-brand-box">N</div>
                <div>
                  <h4 className="pay-modal-title" id="pay-modal-title">Neoteric Digital</h4>
                  <p className="pay-modal-sub">Official Salary Disbursement Statement</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPayslip(null)}
                aria-label="Close payslip dialog"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pay-text-tertiary)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="pay-meta-box">
              <div>
                <span className="pay-meta-label">Personnel</span>
                <span className="pay-meta-val">
                  {selectedPayslip.employee?.firstName} {selectedPayslip.employee?.lastName}
                </span>
                <span style={{ display: 'block', fontFamily: 'var(--pay-font-mono)', fontSize: '11px', color: 'var(--pay-text-tertiary)' }}>
                  {selectedPayslip.employee?.employeeNumber || '—'}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="pay-meta-label">Disbursement Period</span>
                <span className="pay-meta-val">
                  Month {selectedPayslip.periodMonth}, {selectedPayslip.periodYear}
                </span>
                <span style={{ display: 'block', fontFamily: 'var(--pay-font-mono)', fontSize: '11px', color: 'var(--pay-positive)', fontWeight: 600 }}>
                  Status: {selectedPayslip.status}
                </span>
              </div>
            </div>

            <div className="pay-breakdown-list">
              <div className="pay-breakdown-row" style={{ fontWeight: 600, borderBottom: '1px solid var(--pay-border)' }}>
                <span style={{ color: 'var(--pay-text-primary)' }}>Component Description</span>
                <span style={{ color: 'var(--pay-text-primary)' }}>Amount ({currencyLabel()})</span>
              </div>

              {Array.isArray(selectedPayslip.breakdown) && selectedPayslip.breakdown.length > 0 ? (
                selectedPayslip.breakdown.map((item, idx) => (
                  <div key={idx} className="pay-breakdown-row">
                    <span style={{ color: 'var(--pay-text-secondary)' }}>{item.component}</span>
                    <span
                      style={{
                        fontFamily: 'var(--pay-font-mono)',
                        fontWeight: 500,
                        color: item.type === 'DEDUCTION' ? 'var(--pay-rose)' : 'var(--pay-text-primary)',
                      }}
                    >
                      {item.type === 'DEDUCTION' ? '-' : '+'}
                      {formatCurrency(item.amount)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="pay-breakdown-row">
                  <span>Gross Salary Allowance</span>
                  <span className="pay-amount-mono">{formatCurrency(selectedPayslip.grossPay)}</span>
                </div>
              )}
            </div>

            <div className="pay-total-card">
              <span className="pay-total-label">Total Net Disbursed:</span>
              <span className="pay-total-val">
                {formatCurrency(selectedPayslip.netPay)}
              </span>
            </div>

            <div className="pay-modal-footer">
              <span style={{ fontSize: '10.5px', fontFamily: 'var(--pay-font-mono)', color: 'var(--pay-text-tertiary)' }}>
                Payslip served by the payroll API
              </span>
              {/* NOTE: no payslip download endpoint exists in the API contract, so the
                  fake "Download Statement" button (which only showed an alert) was removed. */}
            </div>
          </div>
        </div>
      )}

      {/* Correction request modal */}
      {correctSlip && (
        <div className="pay-modal-overlay" onClick={() => setCorrectSlip(null)}>
          <div
            ref={correctModalRef}
            className="pay-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="correction-modal-title"
          >
            <div className="pay-modal-header">
              <div>
                <h4 className="pay-modal-title" id="correction-modal-title">Request payroll correction</h4>
                <p className="pay-modal-sub">
                  {correctSlip.employee?.firstName} {correctSlip.employee?.lastName} —{' '}
                  Month {correctSlip.periodMonth}, {correctSlip.periodYear} —{' '}
                  {formatCurrency(correctSlip.netPay)} net
                </p>
              </div>
              <button
                onClick={() => setCorrectSlip(null)}
                aria-label="Close correction request dialog"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pay-text-tertiary)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCorrection} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {correctError && (
                <div
                  role="alert"
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(244, 63, 94, 0.08)',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                    color: '#f43f5e',
                    fontSize: '12.5px',
                  }}
                >
                  {correctError}
                </div>
              )}
              <div>
                <label htmlFor="correction-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--pay-text-secondary)', marginBottom: '6px' }}>
                  Reason for correction
                </label>
                <textarea
                  id="correction-reason"
                  required
                  rows={4}
                  value={correctReason}
                  onChange={(e) => setCorrectReason(e.target.value)}
                  placeholder="e.g. Overtime hours for week 3 were missing from the run"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--pay-radius-md)',
                    border: '1px solid var(--pay-border)',
                    background: 'var(--pay-surface-muted)',
                    fontSize: '13px',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setCorrectSlip(null)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 'var(--pay-radius-md)',
                    border: '1px solid var(--pay-border)',
                    background: 'var(--pay-surface-muted)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button type="submit" disabled={correctBusy} className="pay-btn-primary">
                  {correctBusy ? 'Submitting…' : 'Submit correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Run Payroll Cycle Modal */}
      {showRunModal && (
        <div className="pay-modal-overlay" onClick={() => setShowRunModal(false)}>
          <div
            ref={runModalRef}
            className="pay-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-modal-title"
          >
            <div className="pay-modal-header">
              <h3 id="run-modal-title" style={{ fontFamily: 'var(--pay-font-serif)', fontSize: '22px', color: 'var(--pay-text-primary)' }}>
                Run Payroll Cycle
              </h3>
              <button
                onClick={() => setShowRunModal(false)}
                aria-label="Close run payroll dialog"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--pay-text-tertiary)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleRunPayroll} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label htmlFor="payroll-month" style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--pay-text-secondary)', marginBottom: '6px' }}>
                  Payroll Month (1 - 12)
                </label>
                <input
                  id="payroll-month"
                  type="number"
                  min={1}
                  max={12}
                  required
                  value={runMonth}
                  onChange={(e) => setRunMonth(parseInt(e.target.value, 10))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--pay-radius-md)',
                    border: '1px solid var(--pay-border)',
                    background: 'var(--pay-surface-muted)',
                    fontFamily: 'var(--pay-font-mono)',
                  }}
                />
              </div>

              <div>
                <label htmlFor="payroll-year" style={{ display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--pay-text-secondary)', marginBottom: '6px' }}>
                  Payroll Year
                </label>
                <input
                  id="payroll-year"
                  type="number"
                  required
                  value={runYear}
                  onChange={(e) => setRunYear(parseInt(e.target.value, 10))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--pay-radius-md)',
                    border: '1px solid var(--pay-border)',
                    background: 'var(--pay-surface-muted)',
                    fontFamily: 'var(--pay-font-mono)',
                  }}
                />
              </div>

              {runError && (
                <div
                  role="alert"
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(244, 63, 94, 0.08)',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                    color: '#f43f5e',
                    fontSize: '12.5px',
                  }}
                >
                  {runError}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '14px' }}>
                <button
                  type="button"
                  onClick={() => setShowRunModal(false)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 'var(--pay-radius-md)',
                    border: '1px solid var(--pay-border)',
                    background: 'var(--pay-surface-muted)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={runningPayroll}
                  className="pay-btn-primary"
                >
                  {runningPayroll ? 'Computing...' : 'Generate Payroll'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
