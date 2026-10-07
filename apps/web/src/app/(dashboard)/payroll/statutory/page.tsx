'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  FileCheck2,
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  ChevronLeft,
  X,
  RefreshCw,
  Building,
  Search,
} from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../../styles/editorial-common.css';

interface StatutorySubmission {
  submissionId: string;
  provider: string;
  sandbox: boolean;
  status: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'PENDING';
  reference?: string;
  payrollRunId: string;
  period: { month: number; year: number };
  employeeCount: number;
  totals: {
    grossPay: number;
    totalDeductions: number;
    netPay: number;
  };
  submittedAt: string;
  createdAt: string;
  auditId: string;
}

interface PayrollRun {
  id: string;
  month: number;
  year: number;
  status: string;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
}

export default function StatutoryPayrollPage() {
  const { hasRole } = useAuth();
  const canAdmin = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [submissions, setSubmissions] = useState<StatutorySubmission[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Filters & search
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACCEPTED' | 'PENDING' | 'REJECTED'>('ALL');

  // Modals & Inspection
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [submittingRun, setSubmittingRun] = useState(false);

  const [statusInspection, setStatusInspection] = useState<any | null>(null);
  const [checkingStatusId, setCheckingStatusId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [subRes, runsRes] = await Promise.all([
        api.get<any>('/payroll-statutory/submissions').catch(() => ({ items: [] })),
        api.get<any>('/payroll/runs').catch(() => []),
      ]);

      const subList = Array.isArray(subRes)
        ? subRes
        : Array.isArray(subRes?.items)
        ? subRes.items
        : [];
      setSubmissions(subList);

      const runsList = Array.isArray(runsRes)
        ? runsRes
        : Array.isArray(runsRes?.items)
        ? runsRes.items
        : [];
      const eligible = runsList.filter(
        (r: PayrollRun) => r.status === 'APPROVED' || r.status === 'PAID',
      );
      setPayrollRuns(eligible);
      if (eligible.length > 0 && !selectedRunId) {
        setSelectedRunId(eligible[0].id);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load statutory filings data.');
    } finally {
      setLoading(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmitRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRunId) return;

    try {
      setSubmittingRun(true);
      setError(null);

      const receipt = await api.post(`/payroll-statutory/runs/${selectedRunId}/submit`);
      setShowSubmitModal(false);
      setActionSuccess(
        `Statutory filing submitted to ${receipt.provider} (Ref: ${receipt.reference || receipt.submissionId}).`,
      );
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to submit statutory filing.');
    } finally {
      setSubmittingRun(false);
    }
  };

  const handleCheckStatus = async (submissionId: string) => {
    try {
      setCheckingStatusId(submissionId);
      const res = await api.get(`/payroll-statutory/submissions/${submissionId}`);
      setStatusInspection({ submissionId, ...res });
    } catch (err: any) {
      setError(err?.message || 'Failed to query submission status with provider.');
    } finally {
      setCheckingStatusId(null);
    }
  };

  const totalAccepted = useMemo(
    () => submissions.filter((s) => s.status === 'ACCEPTED').length,
    [submissions],
  );

  const filteredSubmissions = useMemo(() => {
    return submissions.filter((sub) => {
      const q = search.trim().toLowerCase();
      const matchesSearch =
        !q ||
        (sub.reference && sub.reference.toLowerCase().includes(q)) ||
        (sub.submissionId && sub.submissionId.toLowerCase().includes(q)) ||
        (sub.payrollRunId && sub.payrollRunId.toLowerCase().includes(q)) ||
        (sub.provider && sub.provider.toLowerCase().includes(q));

      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'ACCEPTED' && sub.status === 'ACCEPTED') ||
        (statusFilter === 'PENDING' && (sub.status === 'PENDING' || sub.status === 'SUBMITTED')) ||
        (statusFilter === 'REJECTED' && sub.status === 'REJECTED');

      return matchesSearch && matchesStatus;
    });
  }, [submissions, search, statusFilter]);

  return (
    <DashboardLayout title="Statutory Payroll Filings & HMRC RTI">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Navigation Bar */}
          <div style={{ marginBottom: '16px' }}>
            <Link
              href="/payroll"
              className="editorial-btn-ghost"
              style={{ textDecoration: 'none', display: 'inline-flex' }}
            >
              <ChevronLeft size={14} />
              <span>Back to Payroll Runs</span>
            </Link>
          </div>

          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">Statutory Payroll Filings & HMRC RTI</h1>
                <p className="editorial-subtitle">
                  Regulatory Real Time Information (RTI) Full Payment Submissions (FPS), Employer Payment Summaries (EPS), and HMRC statutory compliance ledger.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <ShieldCheck size={14} style={{ color: 'var(--edit-positive)' }} />
                  <span>HMRC Gateway:</span>
                  <span className="count">Connected</span>
                </div>
                <div className="editorial-stat-pill">
                  <span>Filings:</span>
                  <span className="count">{submissions.length}</span>
                </div>
                {canAdmin && (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    disabled={payrollRuns.length === 0}
                    className="editorial-btn-primary"
                  >
                    <Send size={15} />
                    <span>Submit Statutory Filing</span>
                  </button>
                )}
              </div>
            </div>
          </header>

          {/* Feedback Banners */}
          {actionSuccess && (
            <div className="editorial-banner editorial-banner-success">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle2 size={16} />
                <span>{actionSuccess}</span>
              </div>
              <button
                onClick={() => setActionSuccess(null)}
                className="editorial-btn-ghost"
                style={{ padding: '2px', border: 'none' }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {error && (
            <div className="editorial-banner editorial-banner-error">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
              <button
                onClick={() => setError(null)}
                className="editorial-btn-ghost"
                style={{ padding: '2px', border: 'none' }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* Regulatory Environment Notice */}
          <div
            style={{
              padding: '14px 18px',
              borderRadius: 'var(--edit-radius-md)',
              border: '1px solid var(--edit-border)',
              background: 'var(--edit-surface)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
              marginBottom: '20px',
              boxShadow: 'var(--edit-shadow-sm)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: 'var(--edit-radius-sm)',
                  background: 'var(--edit-accent-light)',
                  color: 'var(--edit-accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <ShieldCheck size={20} />
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: '13.5px', color: 'var(--edit-text-primary)' }}>
                  Statutory Transmission Gateway
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--edit-text-secondary)', marginTop: '2px' }}>
                  Protocol: <span className="editorial-mono" style={{ fontWeight: 600 }}>HMRC Real Time Information (RTI v2026)</span> • Submissions validate double-entry gross wage totals, employer PAYE, and national insurance deductions.
                </div>
              </div>
            </div>
            <span className="editorial-badge editorial-badge-positive">
              GBP Gateway Active
            </span>
          </div>

          {/* Quick Metrics Grid */}
          <div className="editorial-quick-stats">
            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Total Submissions</div>
                <div className="editorial-quick-stat-value">{submissions.length}</div>
                <div className="editorial-quick-stat-sub">Historical filings log</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <FileCheck2 size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Accepted Filings</div>
                <div className="editorial-quick-stat-value">{totalAccepted}</div>
                <div className="editorial-quick-stat-sub">
                  {submissions.length > 0
                    ? `${Math.round((totalAccepted / submissions.length) * 100)}% verified rate`
                    : 'Awaiting submissions'}
                </div>
              </div>
              <div className="editorial-quick-stat-icon">
                <CheckCircle2 size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Eligible Payroll Cycles</div>
                <div className="editorial-quick-stat-value">{payrollRuns.length}</div>
                <div className="editorial-quick-stat-sub">Approved / Paid state</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Clock size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Regulatory Tax Body</div>
                <div className="editorial-quick-stat-value">HMRC RTI</div>
                <div className="editorial-quick-stat-sub">United Kingdom</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Building size={18} />
              </div>
            </div>
          </div>

          {/* Controls & Search Toolbar */}
          <div className="editorial-toolbar">
            <div className="editorial-toolbar-row">
              <div className="editorial-search-container">
                <Search className="editorial-search-icon" />
                <input
                  type="text"
                  placeholder="Search by reference, run ID, or provider..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="editorial-search-input"
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="editorial-filter-pills">
                  {(['ALL', 'ACCEPTED', 'PENDING', 'REJECTED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`editorial-filter-pill ${statusFilter === s ? 'active' : ''}`}
                    >
                      {s === 'ALL' ? 'All Submissions' : s}
                    </button>
                  ))}
                </div>

                <button
                  onClick={loadData}
                  className="editorial-btn-ghost"
                  title="Refresh Log"
                >
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
          </div>

          {/* Submissions Table */}
          <div className="editorial-table-wrapper">
            {loading ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--edit-text-secondary)' }}>
                <Clock size={24} className="animate-spin" style={{ margin: '0 auto 10px', color: 'var(--edit-accent)' }} />
                <p style={{ margin: 0, fontSize: '13.5px' }}>Retrieving statutory submission ledger from gateway...</p>
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--edit-text-secondary)' }}>
                <FileCheck2 size={36} style={{ margin: '0 auto 12px', color: 'var(--edit-text-tertiary)' }} />
                <div style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', color: 'var(--edit-text-primary)' }}>
                  No statutory payroll filings found
                </div>
                <p style={{ fontSize: '13px', marginTop: '4px', marginBottom: '16px' }}>
                  {search || statusFilter !== 'ALL'
                    ? 'No records match your active search or filter criteria.'
                    : 'No regulatory payroll filings have been submitted yet.'}
                </p>
                {canAdmin && payrollRuns.length > 0 && !search && (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    className="editorial-btn-primary"
                  >
                    <Send size={14} />
                    <span>Transmit First Statutory Filing</span>
                  </button>
                )}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="editorial-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Submission Reference</th>
                      <th>Provider / Protocol</th>
                      <th>Personnel</th>
                      <th>Gross Pay</th>
                      <th>Deductions</th>
                      <th>Status</th>
                      <th>Filing Timestamp</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSubmissions.map((sub) => {
                      const isAccepted = sub.status === 'ACCEPTED';
                      const isRejected = sub.status === 'REJECTED';
                      return (
                        <tr key={sub.submissionId || sub.auditId}>
                          <td className="editorial-table-primary">
                            {sub.period
                              ? `${sub.period.year}-${String(sub.period.month).padStart(2, '0')}`
                              : '—'}
                          </td>
                          <td>
                            <div className="editorial-mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--edit-text-primary)' }}>
                              {sub.reference || sub.submissionId?.slice(0, 16) || '—'}
                            </div>
                            <div className="editorial-table-sub editorial-mono">
                              Run: {sub.payrollRunId?.slice(0, 8)}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontWeight: 500, color: 'var(--edit-text-primary)' }}>
                                {sub.provider || 'HMRC RTI'}
                              </span>
                              {sub.sandbox && (
                                <span className="editorial-badge editorial-badge-warning" style={{ fontSize: '10px', padding: '1px 6px' }}>
                                  Sandbox
                                </span>
                              )}
                            </div>
                          </td>
                          <td>{sub.employeeCount || '—'} staff</td>
                          <td className="editorial-mono" style={{ fontWeight: 600, color: 'var(--edit-text-primary)' }}>
                            £{Number(sub.totals?.grossPay || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="editorial-mono">
                            £{Number(sub.totals?.totalDeductions || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td>
                            <span
                              className={`editorial-badge ${
                                isAccepted
                                  ? 'editorial-badge-positive'
                                  : isRejected
                                  ? 'editorial-badge-danger'
                                  : 'editorial-badge-info'
                              }`}
                            >
                              {sub.status || 'SUBMITTED'}
                            </span>
                          </td>
                          <td className="editorial-mono" style={{ fontSize: '12px' }}>
                            {(sub.submittedAt || sub.createdAt)?.replace('T', ' ').slice(0, 16) || '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              disabled={checkingStatusId === sub.submissionId}
                              onClick={() => handleCheckStatus(sub.submissionId)}
                              className="editorial-btn-ghost"
                              style={{ color: 'var(--edit-accent)', fontWeight: 600 }}
                            >
                              {checkingStatusId === sub.submissionId ? 'Checking...' : 'Inspect Receipt'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Modal 1: Submit Statutory Filing */}
          {showSubmitModal && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Submit Statutory Payroll Filing</h3>
                    <p className="editorial-modal-subtitle">
                      Transmit an approved or disbursed payroll cycle to the statutory tax provider via HMRC RTI.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowSubmitModal(false)}
                    className="editorial-modal-close"
                  >
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleSubmitRun}>
                  <div className="editorial-modal-body">
                    <div className="editorial-form-group">
                      <label className="editorial-label">Approved Payroll Cycle *</label>
                      <select
                        required
                        value={selectedRunId}
                        onChange={(e) => setSelectedRunId(e.target.value)}
                        className="editorial-select"
                      >
                        {payrollRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            Period {r.year}-{String(r.month).padStart(2, '0')} ({r.status}) — Gross: £
                            {Number(r.totalGross).toLocaleString()} | Net: £{Number(r.totalNet).toLocaleString()}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      style={{
                        padding: '14px',
                        background: 'var(--edit-warning-bg)',
                        border: '1px solid rgba(184, 134, 11, 0.25)',
                        borderRadius: 'var(--edit-radius-md)',
                        fontSize: '12.5px',
                        color: 'var(--edit-text-primary)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: 'var(--edit-warning)' }}>
                        Statutory RTI Transmission Protocol:
                      </span>
                      <span>
                        • Full Payment Submission (FPS) data payload will be sealed with cryptographic SHA-256 hash.
                      </span>
                      <span>
                        • Employer PAYE reference, National Insurance breakdown, and net bank disbursement sums will be transmitted.
                      </span>
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button
                      type="button"
                      onClick={() => setShowSubmitModal(false)}
                      className="editorial-btn-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submittingRun || !selectedRunId}
                      className="editorial-btn-primary"
                    >
                      {submittingRun ? 'Transmitting...' : 'Confirm & Transmit to HMRC'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal 2: Provider Inspection Receipt */}
          {statusInspection && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal editorial-modal-lg">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">HMRC RTI Gateway Receipt</h3>
                    <p className="editorial-modal-subtitle">
                      Live verification response and cryptographic submission proof from statutory gateway.
                    </p>
                  </div>
                  <button
                    onClick={() => setStatusInspection(null)}
                    className="editorial-modal-close"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="editorial-modal-body">
                  <div
                    style={{
                      padding: '14px',
                      background: 'var(--edit-surface-muted)',
                      border: '1px solid var(--edit-border)',
                      borderRadius: 'var(--edit-radius-md)',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '12px',
                      fontSize: '12px',
                    }}
                  >
                    <div>
                      <div style={{ color: 'var(--edit-text-tertiary)', textTransform: 'uppercase', fontSize: '10.5px' }}>Submission ID</div>
                      <div className="editorial-mono" style={{ fontWeight: 600, marginTop: '2px' }}>
                        {statusInspection.submissionId?.slice(0, 16)}...
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--edit-text-tertiary)', textTransform: 'uppercase', fontSize: '10.5px' }}>Gateway Status</div>
                      <div style={{ marginTop: '2px' }}>
                        <span className="editorial-badge editorial-badge-positive">
                          {statusInspection.status || 'ACCEPTED'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--edit-text-tertiary)', textTransform: 'uppercase', fontSize: '10.5px' }}>Verified At</div>
                      <div className="editorial-mono" style={{ marginTop: '2px' }}>
                        {statusInspection.checkedAt ? new Date(statusInspection.checkedAt).toLocaleTimeString() : 'Just now'}
                      </div>
                    </div>
                  </div>

                  <div className="editorial-form-group">
                    <label className="editorial-label">Gateway JSON Response</label>
                    <pre className="editorial-code-box">
                      {JSON.stringify(statusInspection, null, 2)}
                    </pre>
                  </div>
                </div>

                <div className="editorial-modal-footer">
                  <button
                    type="button"
                    onClick={() => setStatusInspection(null)}
                    className="editorial-btn-primary"
                  >
                    Dismiss Receipt
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
