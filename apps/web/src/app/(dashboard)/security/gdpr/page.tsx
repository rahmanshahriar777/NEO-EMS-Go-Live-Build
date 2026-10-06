'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  Download,
  Trash2,
  CheckCircle2,
  AlertCircle,
  X,
  Clock,
  UserCheck,
  UserX,
  FileText,
  Scale,
  Calendar,
  AlertTriangle,
  RefreshCw,
  Search,
  ExternalLink,
} from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../../styles/admin.css';

interface ErasureRequest {
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
  employee?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    employeeNumber?: string;
  };
}

interface RetentionRule {
  entity: string;
  retentionDays: number;
  basis: string;
  purgeable: boolean;
}

interface RetentionSchedule {
  version: string;
  signedOff: boolean;
  signoffEnv: string;
  rules: RetentionRule[];
}

export default function GdprPage() {
  const { user, hasRole } = useAuth();
  const canAdmin = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [activeTab, setActiveTab] = useState<'dsar' | 'queue' | 'retention'>('dsar');

  // DSAR State
  const [downloadingDsar, setDownloadingDsar] = useState(false);
  const [erasureReason, setErasureReason] = useState('');
  const [erasureDate, setErasureDate] = useState('');
  const [submittingErasure, setSubmittingErasure] = useState(false);

  // Queue State
  const [erasureRequests, setErasureRequests] = useState<ErasureRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [reviewingRequest, setReviewingRequest] = useState<ErasureRequest | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reviewReason, setReviewReason] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  // Retention State
  const [retentionSchedule, setRetentionSchedule] = useState<RetentionSchedule | null>(null);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [purgePreview, setPurgePreview] = useState<any | null>(null);
  const [previewingPurge, setPreviewingPurge] = useState(false);

  // Feedback
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load Erasure Requests
  const loadRequests = useCallback(async () => {
    if (!canAdmin) return;
    try {
      setLoadingRequests(true);
      const res = await api.get<any>('/gdpr/erasure-requests');
      const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      setErasureRequests(list);
    } catch (err: any) {
      // Non-blocking if table is clean
    } finally {
      setLoadingRequests(false);
    }
  }, [canAdmin]);

  // Load Retention Schedule
  const loadSchedule = useCallback(async () => {
    if (!canAdmin) return;
    try {
      setLoadingSchedule(true);
      const res = await api.get<RetentionSchedule>('/gdpr/retention/schedule');
      setRetentionSchedule(res);
    } catch (err: any) {
      // Non-blocking
    } finally {
      setLoadingSchedule(false);
    }
  }, [canAdmin]);

  useEffect(() => {
    if (activeTab === 'queue') loadRequests();
    if (activeTab === 'retention') loadSchedule();
  }, [activeTab, loadRequests, loadSchedule]);

  const handleDownloadDsar = async () => {
    try {
      setDownloadingDsar(true);
      setError(null);
      await api.downloadFile(
        '/gdpr/export',
        `gdpr-dsar-export-${new Date().toISOString().split('T')[0]}.json`
      );
      setActionSuccess('Your personal data archive (DSAR) has been downloaded successfully.');
    } catch (err: any) {
      setError(err?.message || 'Failed to generate DSAR data export.');
    } finally {
      setDownloadingDsar(false);
    }
  };

  const handleCreateErasureRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSubmittingErasure(true);
      setError(null);
      await api.post('/gdpr/erasure-requests', {
        reason: erasureReason.trim(),
        preferredDate: erasureDate || undefined,
      });
      setErasureReason('');
      setErasureDate('');
      setActionSuccess('Right to Erasure request submitted. HR compliance officers have been notified.');
    } catch (err: any) {
      setError(err?.message || 'Failed to submit erasure request.');
    } finally {
      setSubmittingErasure(false);
    }
  };

  const handleReviewRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewingRequest) return;
    if (reviewDecision === 'REJECT' && !reviewReason.trim()) {
      setError('A statutory justification is required when rejecting an erasure request.');
      return;
    }

    try {
      setSubmittingReview(true);
      setError(null);
      await api.post(`/gdpr/erasure-requests/${reviewingRequest.id}/review`, {
        decision: reviewDecision,
        reason: reviewReason.trim() || undefined,
      });
      setReviewingRequest(null);
      setReviewReason('');
      setActionSuccess(`Erasure request ${reviewDecision.toLowerCase()}d successfully.`);
      loadRequests();
    } catch (err: any) {
      setError(err?.message || 'Failed to review erasure request.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handlePreviewPurge = async () => {
    try {
      setPreviewingPurge(true);
      setError(null);
      const res = await api.get('/gdpr/retention/preview');
      setPurgePreview(res);
      setActionSuccess('Retention purge dry-run preview completed.');
    } catch (err: any) {
      setError(err?.message || 'Failed to preview retention purge.');
    } finally {
      setPreviewingPurge(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Header */}
        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-rose-50 text-rose-700">
                <Shield size={22} />
              </span>
              <h1 className="adm-title">GDPR & Data Protection Privacy Center</h1>
            </div>
            <p className="adm-subtitle">
              Exercise personal GDPR rights (DSAR Article 15/20, Right to Erasure Article 17), manage compliance review queues, and inspect legal retention schedules.
            </p>
          </div>

          {/* Tab Selector */}
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl text-xs font-semibold text-gray-600">
            <button
              onClick={() => setActiveTab('dsar')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'dsar' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
              }`}
            >
              My Privacy & DSAR
            </button>
            {canAdmin && (
              <>
                <button
                  onClick={() => setActiveTab('queue')}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    activeTab === 'queue' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
                  }`}
                >
                  Erasure Requests
                </button>
                <button
                  onClick={() => setActiveTab('retention')}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    activeTab === 'retention' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
                  }`}
                >
                  Retention Schedule
                </button>
              </>
            )}
          </div>
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

        {/* TAB 1: DSAR SELF-SERVICE & ERASURE REQUEST */}
        {activeTab === 'dsar' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Card 1: DSAR Data Portability */}
            <div className="adm-card flex flex-col justify-between gap-5">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="p-2 rounded-xl bg-blue-50 text-blue-700">
                      <Download size={18} />
                    </span>
                    <h2 className="text-base font-bold text-gray-900">Data Portability (DSAR Article 15/20)</h2>
                  </div>
                  <span className="text-[11px] font-bold bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full">
                    Self-Service
                  </span>
                </div>

                <p className="text-xs text-gray-500 leading-relaxed mb-4">
                  Under the General Data Protection Regulation (GDPR), you have the right to obtain confirmation and an
                  itemized digital archive of all personal data held about you by Neoteric Digital EMS.
                </p>

                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-600 flex flex-col gap-1.5 mb-4">
                  <span className="font-semibold text-gray-800">Your Archive Contains:</span>
                  <span>• Employee Profile & Contact Details</span>
                  <span>• Complete Shift Attendance & Biometric Timestamp Records</span>
                  <span>• Leave Request History & Balances</span>
                  <span>• Historical Itemized Payslips</span>
                  <span>• Performance Appraisals, Goals & Peer Feedback</span>
                  <span>• Document Sign-off & Audit Log Activity</span>
                </div>
              </div>

              <div className="pt-3 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-400">Standard Machine-Readable JSON</span>
                <button
                  type="button"
                  disabled={downloadingDsar}
                  onClick={handleDownloadDsar}
                  className="adm-btn adm-btn-primary adm-btn-sm"
                >
                  <Download size={13} />
                  <span>{downloadingDsar ? 'Generating Archive...' : 'Download Personal Archive'}</span>
                </button>
              </div>
            </div>

            {/* Card 2: Right to Erasure Request */}
            <div className="adm-card flex flex-col justify-between gap-5">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="p-2 rounded-xl bg-rose-50 text-rose-700">
                      <Trash2 size={18} />
                    </span>
                    <h2 className="text-base font-bold text-gray-900">Right to Erasure (Article 17)</h2>
                  </div>
                  <span className="text-[11px] font-bold bg-rose-100 text-rose-800 px-2.5 py-0.5 rounded-full">
                    Subject Request
                  </span>
                </div>

                <p className="text-xs text-gray-500 leading-relaxed mb-3">
                  Submit a formal request to erase your personal identifiable information (PII). Approval tokenizes
                  personal identifiers and terminates credentials.
                </p>

                <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 mb-4 flex items-start gap-2">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-700" />
                  <span>
                    <strong>Statutory Exclusions:</strong> HMRC payroll tax history and statutory attendance logs are
                    legally preserved under statutory retention duties and will not be erased.
                  </span>
                </div>

                <form onSubmit={handleCreateErasureRequest} className="flex flex-col gap-3">
                  <div className="adm-form-group">
                    <label className="adm-label">Reason for Erasure Request *</label>
                    <textarea
                      rows={2}
                      required
                      placeholder="e.g. Employment ended; request removal of personal data and contact details."
                      value={erasureReason}
                      onChange={(e) => setErasureReason(e.target.value)}
                      className="adm-input text-xs"
                    />
                  </div>

                  <div className="adm-form-group">
                    <label className="adm-label">Preferred Effective Date (Optional)</label>
                    <input
                      type="date"
                      value={erasureDate}
                      onChange={(e) => setErasureDate(e.target.value)}
                      className="adm-input text-xs"
                    />
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={submittingErasure}
                      className="adm-btn adm-btn-danger adm-btn-sm"
                    >
                      <Trash2 size={13} />
                      <span>{submittingErasure ? 'Submitting...' : 'Submit Erasure Request'}</span>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: ERASURE REQUEST REVIEW QUEUE (ADMIN) */}
        {activeTab === 'queue' && canAdmin && (
          <div className="adm-card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-gray-900">Erasure Review Queue</h2>
                <p className="text-xs text-gray-500">
                  Requests submitted by data subjects. Approval initiates tokenized anonymisation across non-statutory records.
                </p>
              </div>

              <button
                onClick={loadRequests}
                className="text-xs flex items-center gap-1.5 text-gray-500 hover:text-gray-900"
              >
                <RefreshCw size={13} className={loadingRequests ? 'animate-spin' : ''} />
                <span>Refresh Queue</span>
              </button>
            </div>

            {loadingRequests ? (
              <div className="adm-empty py-12 flex items-center justify-center gap-2">
                <Clock size={16} className="animate-spin" />
                <span>Loading erasure requests...</span>
              </div>
            ) : erasureRequests.length === 0 ? (
              <div className="adm-empty py-12">
                <CheckCircle2 size={32} className="mx-auto text-gray-300 mb-2" />
                <p>No pending erasure requests in queue.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Requested At</th>
                      <th>Reason</th>
                      <th>Preferred Date</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {erasureRequests.map((req) => (
                      <tr key={req.id}>
                        <td>
                          <div className="font-semibold text-gray-900">
                            {req.employee ? `${req.employee.firstName} ${req.employee.lastName}` : 'Anonymised Subject'}
                          </div>
                          <div className="text-xs text-gray-500 font-mono">
                            {req.employee?.email || req.employeeId.slice(0, 8)}
                          </div>
                        </td>
                        <td className="text-xs text-gray-500">{req.requestedAt?.split('T')[0]}</td>
                        <td className="text-xs text-gray-700 max-w-xs truncate" title={req.reason}>
                          {req.reason}
                        </td>
                        <td className="text-xs text-gray-500">{req.preferredDate?.split('T')[0] || 'Immediate'}</td>
                        <td>
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                              req.status === 'APPROVED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : req.status === 'REJECTED'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {req.status}
                          </span>
                        </td>
                        <td>
                          {req.status === 'PENDING' ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReviewingRequest(req);
                                setReviewDecision('APPROVE');
                                setReviewReason('');
                              }}
                              className="adm-btn adm-btn-primary adm-btn-sm text-xs"
                            >
                              Review
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">Decided</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: RETENTION SCHEDULE & PURGE (ADMIN) */}
        {activeTab === 'retention' && canAdmin && (
          <div className="flex flex-col gap-6">
            {/* Status Banner */}
            <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/70 flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-amber-100 text-amber-800 rounded-lg">
                  <Scale size={18} />
                </div>
                <div>
                  <div className="font-bold text-sm text-amber-950">
                    Retention Schedule Status:{' '}
                    {retentionSchedule?.signedOff ? 'Counsel Signed Off (Live)' : 'Placeholder (Dry-Run Enforced)'}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">
                    Schedule Version: {retentionSchedule?.version || '1.0'}. Per-entity retention windows require formal
                    counsel sign-off before automatic deletion triggers.
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={previewingPurge}
                onClick={handlePreviewPurge}
                className="adm-btn adm-btn-primary adm-btn-sm whitespace-nowrap self-start md:self-auto"
              >
                <RefreshCw size={13} className={previewingPurge ? 'animate-spin' : ''} />
                <span>{previewingPurge ? 'Scanning...' : 'Simulate Dry-Run Purge'}</span>
              </button>
            </div>

            {/* Dry-run preview results if available */}
            {purgePreview && (
              <div className="adm-card">
                <h3 className="text-sm font-bold text-gray-900 mb-2">Simulated Purge Results (Dry-Run)</h3>
                <pre className="p-3 bg-gray-900 text-emerald-400 rounded-xl text-xs font-mono overflow-x-auto max-h-48">
                  {JSON.stringify(purgePreview, null, 2)}
                </pre>
              </div>
            )}

            {/* Rules Table */}
            <div className="adm-card flex flex-col gap-4">
              <h2 className="text-base font-bold text-gray-900">Per-Entity Retention Windows & Legal Bases</h2>

              {loadingSchedule ? (
                <div className="adm-empty">Loading retention rules...</div>
              ) : !retentionSchedule?.rules ? (
                <div className="adm-empty">No schedule rules loaded.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        <th>Entity Category</th>
                        <th>Retention Period</th>
                        <th>Legal & Statutory Basis</th>
                        <th>Purge Behavior</th>
                      </tr>
                    </thead>
                    <tbody>
                      {retentionSchedule.rules.map((rule) => (
                        <tr key={rule.entity}>
                          <td className="font-semibold text-gray-900 font-mono text-xs">{rule.entity}</td>
                          <td className="text-gray-700">
                            {rule.retentionDays >= 365
                              ? `${Math.round(rule.retentionDays / 365)} years`
                              : `${rule.retentionDays} days`}
                          </td>
                          <td className="text-xs text-gray-600">{rule.basis}</td>
                          <td>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                rule.purgeable
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-gray-100 text-gray-700'
                              }`}
                            >
                              {rule.purgeable ? 'Eligible for Purge' : 'Protected (Statutory)'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal: Review Erasure Request */}
        {reviewingRequest && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Review Right to Erasure Request</h3>
                <button onClick={() => setReviewingRequest(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Subject: <strong>{reviewingRequest.employee?.firstName} {reviewingRequest.employee?.lastName}</strong> (
                {reviewingRequest.employee?.email})
              </p>

              <form onSubmit={handleReviewRequest}>
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-700 mb-4">
                  <div className="font-semibold mb-1">Subject Stated Reason:</div>
                  <div className="italic">"{reviewingRequest.reason}"</div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Decision *</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setReviewDecision('APPROVE')}
                      className={`p-3 rounded-xl border text-center font-semibold text-xs transition-all ${
                        reviewDecision === 'APPROVE'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                          : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Approve & Anonymise
                    </button>
                    <button
                      type="button"
                      onClick={() => setReviewDecision('REJECT')}
                      className={`p-3 rounded-xl border text-center font-semibold text-xs transition-all ${
                        reviewDecision === 'REJECT'
                          ? 'border-rose-600 bg-rose-50 text-rose-800'
                          : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Reject Request
                    </button>
                  </div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">
                    {reviewDecision === 'REJECT' ? 'Statutory Rejection Reason *' : 'Compliance Notes (Optional)'}
                  </label>
                  <textarea
                    rows={3}
                    required={reviewDecision === 'REJECT'}
                    placeholder={
                      reviewDecision === 'REJECT'
                        ? 'Cite statutory retention obligation (e.g. Ongoing legal dispute, active statutory audit requirement)...'
                        : 'Optional notes on anonymisation sign-off...'
                    }
                    value={reviewReason}
                    onChange={(e) => setReviewReason(e.target.value)}
                    className="adm-input text-xs"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setReviewingRequest(null)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submittingReview}
                    className={`adm-btn ${
                      reviewDecision === 'APPROVE' ? 'adm-btn-primary' : 'adm-btn-danger'
                    }`}
                  >
                    {submittingReview
                      ? 'Processing...'
                      : reviewDecision === 'APPROVE'
                      ? 'Confirm Anonymisation'
                      : 'Reject Request'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
