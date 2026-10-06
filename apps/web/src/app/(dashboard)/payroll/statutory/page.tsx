'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  FileCheck2,
  Send,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldAlert,
  ShieldCheck,
  ChevronLeft,
  X,
  RefreshCw,
  Building,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../../styles/admin.css';

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
      // Only runs that are APPROVED or PAID can be filed
      const eligible = runsList.filter(
        (r: PayrollRun) => r.status === 'APPROVED' || r.status === 'PAID'
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
        `Statutory filing submitted to ${receipt.provider} (Ref: ${receipt.reference || receipt.submissionId}).`
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

  const totalAccepted = submissions.filter((s) => s.status === 'ACCEPTED').length;

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Back Link & Header */}
        <div className="flex items-center gap-2 mb-1">
          <Link
            href="/payroll"
            className="flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-900 transition-colors"
          >
            <ChevronLeft size={14} />
            <span>Back to Payroll Runs</span>
          </Link>
        </div>

        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-indigo-50 text-indigo-700">
                <FileCheck2 size={22} />
              </span>
              <h1 className="adm-title">Statutory Payroll Filings & HMRC RTI</h1>
            </div>
            <p className="adm-subtitle">
              Regulatory compliance filings, HMRC Real Time Information (RTI) Full Payment Submissions (FPS), and sandbox transmission logs.
            </p>
          </div>

          {canAdmin && (
            <button
              onClick={() => setShowSubmitModal(true)}
              disabled={payrollRuns.length === 0}
              className="adm-btn adm-btn-primary"
            >
              <Send size={15} />
              <span>Submit Statutory Filing</span>
            </button>
          )}
        </div>

        {/* Feedback Banners */}
        {actionSuccess && (
          <div className="flex items-center justify-between p-4 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-sm">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={18} className="text-emerald-600" />
              <span>{actionSuccess}</span>
            </div>
            <button onClick={() => setActionSuccess(null)} className="text-emerald-600 hover:text-emerald-900">
              <X size={16} />
            </button>
          </div>
        )}

        {error && (
          <div className="adm-error flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-rose-600 hover:text-rose-900">
              <X size={16} />
            </button>
          </div>
        )}

        {/* Provider Environment Banner */}
        <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/70 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-blue-100 text-blue-800 rounded-lg">
              <ShieldCheck size={18} />
            </div>
            <div>
              <div className="font-bold text-sm text-blue-950">Statutory Transmission Environment</div>
              <div className="text-xs text-blue-800 mt-0.5">
                Configured Provider: <span className="font-mono font-semibold">Sandbox / HMRC RTI Protocol</span>. Submissions enforce approved double-entry gross wage totals and statutory deductions.
              </div>
            </div>
          </div>
          <span className="text-xs font-bold px-3 py-1 bg-blue-200 text-blue-900 rounded-full self-start md:self-auto">
            GBP Gateway Active
          </span>
        </div>

        {/* Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-indigo-50 text-indigo-700">
              <FileCheck2 size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Submissions</div>
              <div className="text-2xl font-bold text-gray-900">{submissions.length}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-emerald-50 text-emerald-700">
              <CheckCircle2 size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Accepted Filings</div>
              <div className="text-2xl font-bold text-gray-900">{totalAccepted}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-amber-50 text-amber-700">
              <Clock size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Eligible Runs</div>
              <div className="text-2xl font-bold text-gray-900">{payrollRuns.length}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-purple-50 text-purple-700">
              <Building size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Regulatory Tax Body</div>
              <div className="text-base font-bold text-gray-900">HMRC RTI</div>
            </div>
          </div>
        </div>

        {/* Submissions Table */}
        <div className="adm-card flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-gray-900">Regulatory Submissions Log</h2>
            <button
              onClick={loadData}
              className="text-xs flex items-center gap-1.5 text-gray-500 hover:text-gray-900"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              <span>Refresh Log</span>
            </button>
          </div>

          {loading ? (
            <div className="adm-empty py-12 flex items-center justify-center gap-2">
              <Clock size={16} className="animate-spin" />
              <span>Loading statutory submissions...</span>
            </div>
          ) : submissions.length === 0 ? (
            <div className="adm-empty py-12">
              <FileCheck2 size={32} className="mx-auto text-gray-300 mb-2" />
              <p>No statutory payroll filings have been submitted yet.</p>
              {canAdmin && payrollRuns.length > 0 && (
                <button
                  onClick={() => setShowSubmitModal(true)}
                  className="adm-btn adm-btn-primary adm-btn-sm mt-3"
                >
                  Submit First Filing
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Submission Ref</th>
                    <th>Provider</th>
                    <th>Employees</th>
                    <th>Gross Wages</th>
                    <th>Deductions</th>
                    <th>Status</th>
                    <th>Filed On</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((sub) => {
                    const isAccepted = sub.status === 'ACCEPTED';
                    return (
                      <tr key={sub.submissionId || sub.auditId}>
                        <td className="font-semibold text-gray-900">
                          {sub.period ? `${sub.period.year}-${String(sub.period.month).padStart(2, '0')}` : '—'}
                        </td>
                        <td>
                          <div className="font-mono text-xs text-gray-700">
                            {sub.reference || sub.submissionId?.slice(0, 16) || '—'}
                          </div>
                          <div className="text-[11px] text-gray-400">Run: {sub.payrollRunId?.slice(0, 8)}</div>
                        </td>
                        <td>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-xs text-gray-800">{sub.provider || 'Sandbox'}</span>
                            {sub.sandbox && (
                              <span className="text-[10px] bg-amber-100 text-amber-800 font-semibold px-1.5 py-0.2 rounded">
                                Test
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-gray-700">{sub.employeeCount || '—'} staff</td>
                        <td className="font-semibold text-gray-900">
                          £{Number(sub.totals?.grossPay || 0).toLocaleString()}
                        </td>
                        <td className="text-gray-700">
                          £{Number(sub.totals?.totalDeductions || 0).toLocaleString()}
                        </td>
                        <td>
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                              isAccepted
                                ? 'bg-emerald-100 text-emerald-800'
                                : sub.status === 'REJECTED'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {sub.status || 'SUBMITTED'}
                          </span>
                        </td>
                        <td className="text-xs text-gray-500">
                          {(sub.submittedAt || sub.createdAt)?.split('T')[0] || '—'}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={checkingStatusId === sub.submissionId}
                            onClick={() => handleCheckStatus(sub.submissionId)}
                            className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 hover:underline"
                          >
                            {checkingStatusId === sub.submissionId ? 'Checking...' : 'Verify Status'}
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

        {/* Modal 1: Submit Run */}
        {showSubmitModal && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Submit Statutory Payroll Filing</h3>
                <button onClick={() => setShowSubmitModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Select an approved or disbursed payroll cycle to transmit to the statutory tax provider.
              </p>

              <form onSubmit={handleSubmitRun}>
                <div className="adm-form-group">
                  <label className="adm-label">Approved Payroll Run *</label>
                  <select
                    required
                    value={selectedRunId}
                    onChange={(e) => setSelectedRunId(e.target.value)}
                    className="adm-select"
                  >
                    {payrollRuns.map((r) => (
                      <option key={r.id} value={r.id}>
                        Period {r.year}-{String(r.month).padStart(2, '0')} ({r.status}) — Gross: £
                        {Number(r.totalGross).toLocaleString()} | Net: £{Number(r.totalNet).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 mt-3 flex flex-col gap-1">
                  <span className="font-semibold">Statutory Transmission Protocol:</span>
                  <span>
                    • Full payment submission details including employer PAYE reference, NI contributions, and gross salaries will be dispatched.
                  </span>
                  <span>• Only runs in APPROVED or PAID state are authorized for transmission.</span>
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setShowSubmitModal(false)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submittingRun || !selectedRunId}
                    className="adm-btn adm-btn-primary"
                  >
                    {submittingRun ? 'Transmitting...' : 'Confirm & Transmit'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal 2: Status Inspection Details */}
        {statusInspection && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Provider Status Verification</h3>
                <button onClick={() => setStatusInspection(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Live verification result from statutory authority gateway.
              </p>

              <div className="flex flex-col gap-3">
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 flex flex-col gap-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Submission ID:</span>
                    <span className="font-mono font-semibold">{statusInspection.submissionId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Status:</span>
                    <span className="font-bold text-emerald-700">
                      {statusInspection.status || 'ACCEPTED'}
                    </span>
                  </div>
                  {statusInspection.checkedAt && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Gateway Checked At:</span>
                      <span>{new Date(statusInspection.checkedAt).toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Provider Gateway Receipt</label>
                  <pre className="p-3 bg-gray-900 text-emerald-400 rounded-xl text-xs font-mono overflow-x-auto max-h-48">
                    {JSON.stringify(statusInspection, null, 2)}
                  </pre>
                </div>

                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    onClick={() => setStatusInspection(null)}
                    className="adm-btn adm-btn-primary adm-btn-sm"
                  >
                    Close Verification
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
