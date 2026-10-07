'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Shield,
  Download,
  Trash2,
  CheckCircle2,
  AlertCircle,
  X,
  Clock,
  Scale,
  RefreshCw,
} from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../../styles/editorial-common.css';

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
  const { hasRole } = useAuth();
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
    } catch {
      // Non-blocking
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
    } catch {
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
        `gdpr-dsar-export-${new Date().toISOString().split('T')[0]}.json`,
      );
      setActionSuccess('Your personal data archive (DSAR) has been compiled and downloaded.');
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
      setActionSuccess('Right to Erasure request submitted. Data Protection Officers have been notified.');
    } catch (err: any) {
      setError(err?.message || 'Failed to submit erasure request.');
    } finally {
      setSubmittingErasure(false);
    }
  };

  const handleReviewRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewingRequest) return;
    try {
      setSubmittingReview(true);
      setError(null);
      await api.patch(`/gdpr/erasure-requests/${reviewingRequest.id}/review`, {
        decision: reviewDecision,
        reason: reviewReason.trim() || undefined,
      });
      setReviewingRequest(null);
      setReviewReason('');
      setActionSuccess(`Erasure request ${reviewDecision.toLowerCase()}ed successfully.`);
      await loadRequests();
    } catch (err: any) {
      setError(err?.message || 'Failed to record erasure review decision.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const handlePreviewPurge = async () => {
    try {
      setPreviewingPurge(true);
      setError(null);
      const res = await api.get('/gdpr/retention/purge-preview');
      setPurgePreview(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to generate retention purge preview.');
    } finally {
      setPreviewingPurge(false);
    }
  };

  const pendingErasuresCount = useMemo(
    () => erasureRequests.filter((r) => r.status === 'PENDING').length,
    [erasureRequests],
  );

  return (
    <DashboardLayout title="GDPR & Data Protection Privacy Center">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">GDPR & Data Protection Privacy Center</h1>
                <p className="editorial-subtitle">
                  Data subject rights governance, Article 15 DSAR exports, Article 17 erasure reviews, and UK GDPR statutory data retention policies.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <Shield size={14} style={{ color: 'var(--edit-accent)' }} />
                  <span>Compliance Framework:</span>
                  <span className="count">UK GDPR / DPA 2018</span>
                </div>
                {canAdmin && (
                  <div className="editorial-stat-pill">
                    <span>Pending Requests:</span>
                    <span className="count">{pendingErasuresCount}</span>
                  </div>
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

          {/* Metric Cards Grid */}
          <div className="editorial-quick-stats">
            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Article 15 Access</div>
                <div className="editorial-quick-stat-value">DSAR</div>
                <div className="editorial-quick-stat-sub">Self-service JSON export</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Download size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Erasure Requests</div>
                <div className="editorial-quick-stat-value">{erasureRequests.length}</div>
                <div className="editorial-quick-stat-sub">{pendingErasuresCount} awaiting review</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Trash2 size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Retention Schedule</div>
                <div className="editorial-quick-stat-value">
                  {retentionSchedule?.rules.length || 6} Rules
                </div>
                <div className="editorial-quick-stat-sub">HMRC & statutory basis</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Scale size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Governance Posture</div>
                <div className="editorial-quick-stat-value">Compliant</div>
                <div className="editorial-quick-stat-sub">Audited access control</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <CheckCircle2 size={18} />
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="editorial-tabs">
            <button
              onClick={() => setActiveTab('dsar')}
              className={`editorial-tab ${activeTab === 'dsar' ? 'active' : ''}`}
            >
              <span>Personal Data & DSAR</span>
            </button>

            {canAdmin && (
              <>
                <button
                  onClick={() => setActiveTab('queue')}
                  className={`editorial-tab ${activeTab === 'queue' ? 'active' : ''}`}
                >
                  <span>Erasure Review Queue</span>
                  {pendingErasuresCount > 0 && (
                    <span className="editorial-tab-badge">{pendingErasuresCount}</span>
                  )}
                </button>

                <button
                  onClick={() => setActiveTab('retention')}
                  className={`editorial-tab ${activeTab === 'retention' ? 'active' : ''}`}
                >
                  <span>Statutory Retention Schedule</span>
                </button>
              </>
            )}
          </div>

          {/* Tab 1: DSAR & Right to Erasure Self-Service */}
          {activeTab === 'dsar' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
              {/* Card 1: Article 15 DSAR */}
              <div
                style={{
                  background: 'var(--edit-surface)',
                  border: '1px solid var(--edit-border)',
                  borderRadius: 'var(--edit-radius-lg)',
                  padding: '24px',
                  boxShadow: 'var(--edit-shadow-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '16px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
                      }}
                    >
                      <Download size={18} />
                    </div>
                    <div>
                      <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                        Article 15: Right of Access (DSAR)
                      </h3>
                      <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                        Data Subject Access Request Export
                      </div>
                    </div>
                  </div>

                  <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', marginTop: '14px', lineHeight: 1.5 }}>
                    Under Article 15 of the UK General Data Protection Regulation, you have the statutory right to obtain a copy of all personal telemetry, employment history, payroll journals, leave balances, and audit actions stored in Neoteric Digital EMS.
                  </p>

                  <div
                    style={{
                      padding: '12px',
                      background: 'var(--edit-surface-muted)',
                      borderRadius: 'var(--edit-radius-md)',
                      border: '1px solid var(--edit-border-subtle)',
                      fontSize: '12px',
                      color: 'var(--edit-text-secondary)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <span>• Formatted as encrypted, machine-readable JSON archive.</span>
                    <span>• Includes profile, attendance check-ins, and performance evaluations.</span>
                  </div>
                </div>

                <button
                  onClick={handleDownloadDsar}
                  disabled={downloadingDsar}
                  className="editorial-btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Download size={15} />
                  <span>{downloadingDsar ? 'Generating Archive...' : 'Download Personal DSAR Archive'}</span>
                </button>
              </div>

              {/* Card 2: Article 17 Right to Erasure */}
              <div
                style={{
                  background: 'var(--edit-surface)',
                  border: '1px solid var(--edit-border)',
                  borderRadius: 'var(--edit-radius-lg)',
                  padding: '24px',
                  boxShadow: 'var(--edit-shadow-sm)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: 'var(--edit-radius-sm)',
                      background: 'var(--edit-rose-bg)',
                      color: 'var(--edit-rose)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Trash2 size={18} />
                  </div>
                  <div>
                    <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                      Article 17: Right to Erasure
                    </h3>
                    <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                      Request Account & Record Anonymization
                    </div>
                  </div>
                </div>

                <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                  Submit a formal request to purge or pseudonymize non-statutory personal data. Note that records subject to mandatory legal retention (e.g. HMRC payroll records under TMA 1970) are retained for 6 years by statutory obligation.
                </p>

                <form onSubmit={handleCreateErasureRequest} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div className="editorial-form-group">
                    <label className="editorial-label">Statutory Reason for Erasure *</label>
                    <textarea
                      required
                      rows={3}
                      placeholder="e.g. Consent withdrawn upon employment termination, records no longer necessary for purpose..."
                      value={erasureReason}
                      onChange={(e) => setErasureReason(e.target.value)}
                      className="editorial-textarea"
                    />
                  </div>

                  <div className="editorial-form-group">
                    <label className="editorial-label">Preferred Effective Date (Optional)</label>
                    <input
                      type="date"
                      value={erasureDate}
                      onChange={(e) => setErasureDate(e.target.value)}
                      className="editorial-input"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submittingErasure || !erasureReason.trim()}
                    className="editorial-btn-danger"
                    style={{ width: '100%', justifyContent: 'center', padding: '9px 16px' }}
                  >
                    <Trash2 size={14} />
                    <span>{submittingErasure ? 'Submitting...' : 'Submit Formal Erasure Request'}</span>
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* Tab 2: Erasure Queue (Admins only) */}
          {activeTab === 'queue' && canAdmin && (
            <div className="editorial-table-wrapper">
              <div
                style={{
                  padding: '16px 20px',
                  borderBottom: '1px solid var(--edit-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                    Article 17 Erasure Applications
                  </h3>
                  <div style={{ fontSize: '12px', color: 'var(--edit-text-secondary)' }}>
                    Compliance officer review decisions and audit ledger
                  </div>
                </div>

                <button onClick={loadRequests} className="editorial-btn-ghost">
                  <RefreshCw size={13} className={loadingRequests ? 'animate-spin' : ''} />
                  <span>Refresh Queue</span>
                </button>
              </div>

              {loadingRequests ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                  <Clock size={20} className="animate-spin" style={{ margin: '0 auto 8px', color: 'var(--edit-accent)' }} />
                  <p style={{ margin: 0, fontSize: '13px' }}>Loading erasure review queue...</p>
                </div>
              ) : erasureRequests.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                  <CheckCircle2 size={36} style={{ margin: '0 auto 12px', color: 'var(--edit-text-tertiary)' }} />
                  <div style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', color: 'var(--edit-text-primary)' }}>
                    No pending erasure requests
                  </div>
                  <p style={{ fontSize: '13px', marginTop: '4px' }}>
                    All data subject deletion requests have been actioned or no requests have been lodged.
                  </p>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="editorial-table">
                    <thead>
                      <tr>
                        <th>Personnel</th>
                        <th>Legal Justification</th>
                        <th>Submission Date</th>
                        <th>Preferred Date</th>
                        <th>Status</th>
                        <th style={{ textAlign: 'right' }}>Compliance Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {erasureRequests.map((req) => {
                        const isPending = req.status === 'PENDING';
                        return (
                          <tr key={req.id}>
                            <td className="editorial-table-primary">
                              <div>
                                {req.employee
                                  ? `${req.employee.firstName} ${req.employee.lastName}`
                                  : `Personnel #${req.employeeId.slice(0, 8)}`}
                              </div>
                              <div className="editorial-table-sub editorial-mono">
                                {req.employee?.email || req.employee?.employeeNumber || '—'}
                              </div>
                            </td>
                            <td style={{ maxWidth: '280px' }}>
                              <div style={{ fontSize: '12.5px', color: 'var(--edit-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {req.reason}
                              </div>
                              {req.reviewReason && (
                                <div className="editorial-table-sub" style={{ fontStyle: 'italic' }}>
                                  Decision note: &ldquo;{req.reviewReason}&rdquo;
                                </div>
                              )}
                            </td>
                            <td className="editorial-mono" style={{ fontSize: '12px' }}>
                              {req.requestedAt ? req.requestedAt.split('T')[0] : '—'}
                            </td>
                            <td className="editorial-mono" style={{ fontSize: '12px' }}>
                              {req.preferredDate || 'Immediate'}
                            </td>
                            <td>
                              <span
                                className={`editorial-badge ${
                                  req.status === 'APPROVED'
                                    ? 'editorial-badge-positive'
                                    : req.status === 'REJECTED'
                                    ? 'editorial-badge-danger'
                                    : 'editorial-badge-warning'
                                }`}
                              >
                                {req.status}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {isPending ? (
                                <button
                                  onClick={() => {
                                    setReviewingRequest(req);
                                    setReviewDecision('APPROVE');
                                    setReviewReason('');
                                  }}
                                  className="editorial-btn-primary"
                                  style={{ fontSize: '11.5px', padding: '4px 10px' }}
                                >
                                  Review Request
                                </button>
                              ) : (
                                <span style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)', fontStyle: 'italic' }}>
                                  Actioned
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Retention Schedule Matrix (Admins only) */}
          {activeTab === 'retention' && canAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div
                style={{
                  background: 'var(--edit-surface)',
                  border: '1px solid var(--edit-border)',
                  borderRadius: 'var(--edit-radius-lg)',
                  padding: '18px 24px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  boxShadow: 'var(--edit-shadow-sm)',
                  flexWrap: 'wrap',
                  gap: '12px',
                }}
              >
                <div>
                  <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                    Statutory Data Retention Schedule
                  </h3>
                  <div style={{ fontSize: '12.5px', color: 'var(--edit-text-secondary)', marginTop: '2px' }}>
                    Version: <span className="editorial-mono" style={{ fontWeight: 600 }}>{retentionSchedule?.version || '2026.1-STABLE'}</span> • Legal Basis: UK DPA 2018 / HMRC Taxes Management Act 1970
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button onClick={loadSchedule} className="editorial-btn-ghost">
                    <RefreshCw size={13} className={loadingSchedule ? 'animate-spin' : ''} />
                    <span>Refresh Schedule</span>
                  </button>
                  <button onClick={handlePreviewPurge} disabled={previewingPurge} className="editorial-btn-secondary">
                    <Trash2 size={14} />
                    <span>{previewingPurge ? 'Evaluating...' : 'Preview Purgeable Records'}</span>
                  </button>
                </div>
              </div>

              {/* Retention Rules Matrix Table */}
              <div className="editorial-table-wrapper">
                <table className="editorial-table">
                  <thead>
                    <tr>
                      <th>Entity Category</th>
                      <th>Retention Window</th>
                      <th>Statutory Legal Basis</th>
                      <th>Automated Purge Eligibility</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(retentionSchedule?.rules || [
                      { entity: 'Payroll Runs & Payslips', retentionDays: 2191, basis: 'HMRC Taxes Management Act 1970 s.12B (6 Years)', purgeable: false },
                      { entity: 'Employee Master Record', retentionDays: 2191, basis: 'Limitation Act 1980 / Breach of Contract (6 Years)', purgeable: false },
                      { entity: 'Time & Attendance Logs', retentionDays: 730, basis: 'Working Time Regulations 1998 (2 Years)', purgeable: true },
                      { entity: 'Leave Requests & Medical', retentionDays: 1095, basis: 'Statutory Sick Pay Regulations (3 Years)', purgeable: true },
                      { entity: 'Performance Appraisals', retentionDays: 1825, basis: 'ACAS Code of Practice on Disciplinary (5 Years)', purgeable: true },
                      { entity: 'System Audit Logs', retentionDays: 365, basis: 'ISO 27001 / SOC 2 Compliance Logging (1 Year)', purgeable: true },
                    ]).map((rule, idx) => (
                      <tr key={idx}>
                        <td className="editorial-table-primary">{rule.entity}</td>
                        <td className="editorial-mono" style={{ fontWeight: 600 }}>
                          {rule.retentionDays} Days ({Math.round(rule.retentionDays / 365)} Years)
                        </td>
                        <td style={{ color: 'var(--edit-text-secondary)', fontSize: '12.5px' }}>
                          {rule.basis}
                        </td>
                        <td>
                          <span
                            className={`editorial-badge ${
                              rule.purgeable ? 'editorial-badge-positive' : 'editorial-badge-neutral'
                            }`}
                          >
                            {rule.purgeable ? 'Purge Eligible' : 'Statutory Lock'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Purge Preview Box */}
              {purgePreview && (
                <div
                  style={{
                    background: 'var(--edit-surface)',
                    border: '1px solid var(--edit-border)',
                    borderRadius: 'var(--edit-radius-lg)',
                    padding: '20px',
                    boxShadow: 'var(--edit-shadow-sm)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <h4 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '18px', margin: 0, fontWeight: 400 }}>
                      Dry-Run Retention Purge Summary
                    </h4>
                    <button onClick={() => setPurgePreview(null)} className="editorial-btn-ghost">
                      <X size={14} />
                    </button>
                  </div>
                  <pre className="editorial-code-box">
                    {JSON.stringify(purgePreview, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Modal: Review Erasure Request */}
          {reviewingRequest && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Review Article 17 Erasure Request</h3>
                    <p className="editorial-modal-subtitle">
                      Applicant: {reviewingRequest.employee?.firstName} {reviewingRequest.employee?.lastName} ({reviewingRequest.employee?.email})
                    </p>
                  </div>
                  <button onClick={() => setReviewingRequest(null)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleReviewRequest}>
                  <div className="editorial-modal-body">
                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 'var(--edit-radius-md)',
                        background: 'var(--edit-surface-muted)',
                        border: '1px solid var(--edit-border-subtle)',
                        fontSize: '12.5px',
                        color: 'var(--edit-text-secondary)',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: 'var(--edit-text-primary)' }}>Applicant Justification: </span>
                      &ldquo;{reviewingRequest.reason}&rdquo;
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Compliance Decision *</label>
                      <select
                        value={reviewDecision}
                        onChange={(e) => setReviewDecision(e.target.value as any)}
                        className="editorial-select"
                      >
                        <option value="APPROVE">Approve Erasure (Pseudonymize Non-Statutory Records)</option>
                        <option value="REJECT">Reject Erasure (Overriding Statutory Retention Obligation)</option>
                      </select>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Formal Review Findings & Legal Rationale</label>
                      <textarea
                        rows={3}
                        placeholder="State legal grounds for decision under UK GDPR Article 17(3)..."
                        value={reviewReason}
                        onChange={(e) => setReviewReason(e.target.value)}
                        className="editorial-textarea"
                      />
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setReviewingRequest(null)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submittingReview} className="editorial-btn-primary">
                      {submittingReview ? 'Recording...' : 'Record Compliance Decision'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
