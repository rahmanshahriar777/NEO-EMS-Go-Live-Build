'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Camera,
  Plus,
  SlidersHorizontal,
  Search,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileText,
  MapPin,
  Calendar,
  User,
  RefreshCw,
  Trash2,
  UploadCloud,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { useAuth } from '../../../context/auth-context';
import { SystemRole, FieldReportStatus, FieldReportCategory } from '@ems/shared';
import {
  useMyFieldReportsQuery,
  useTeamFieldReportsQuery,
  useFieldReportSitesQuery,
} from '../../../lib/field-reports-queries';
import {
  listDrafts,
  listOutboxFiles,
  updateOutboxFile,
  deleteDraft,
  LocalDraft,
  OutboxFile,
} from '../../../lib/field-reports-idb';
import '../../../styles/field-reports.css';

export default function FieldReportsPage() {
  const { hasRole } = useAuth();
  const isManagerOrAdmin = hasRole(
    SystemRole.MANAGER,
    SystemRole.HR_ADMIN,
    SystemRole.SUPER_ADMIN,
  );

  const [activeTab, setActiveTab] = useState<'my' | 'team' | 'outbox'>(
    isManagerOrAdmin ? 'team' : 'my',
  );

  // Filters for My Reports
  const [myPage, setMyPage] = useState(1);
  const [myStatus, setMyStatus] = useState<string>('');
  const [myCategory, setMyCategory] = useState<string>('');
  const [mySearch, setMySearch] = useState<string>('');

  // Filters for Team Reports
  const [teamPage, setTeamPage] = useState(1);
  const [teamStatus, setTeamStatus] = useState<string>('SUBMITTED');
  const [teamCategory, setTeamCategory] = useState<string>('');
  const [teamSiteId, setTeamSiteId] = useState<string>('');
  const [teamSearch, setTeamSearch] = useState<string>('');

  // Local drafts & outbox state
  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>([]);
  const [outboxFiles, setOutboxFiles] = useState<OutboxFile[]>([]);
  const [loadingOutbox, setLoadingOutbox] = useState(false);

  const { data: myData, isLoading: myLoading, refetch: refetchMy } = useMyFieldReportsQuery({
    page: myPage,
    limit: 12,
    status: myStatus || undefined,
    category: myCategory || undefined,
    search: mySearch || undefined,
  });

  const { data: teamData, isLoading: teamLoading, refetch: refetchTeam } = useTeamFieldReportsQuery({
    page: teamPage,
    limit: 12,
    status: teamStatus || undefined,
    category: teamCategory || undefined,
    siteId: teamSiteId || undefined,
    search: teamSearch || undefined,
  });

  const { data: sites } = useFieldReportSitesQuery();

  const loadOutboxData = async () => {
    setLoadingOutbox(true);
    try {
      const drafts = await listDrafts();
      const files = await listOutboxFiles();
      setLocalDrafts(drafts);
      setOutboxFiles(files);
    } finally {
      setLoadingOutbox(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'outbox') {
      loadOutboxData();
    }
  }, [activeTab]);

  const handleDeleteDraft = async (localId: string) => {
    if (window.confirm('Delete this offline draft and its pending attachments?')) {
      await deleteDraft(localId);
      await loadOutboxData();
    }
  };

  const getStatusBadge = (status: FieldReportStatus) => {
    switch (status) {
      case FieldReportStatus.APPROVED:
        return (
          <span className="fr-status-pill fr-status-APPROVED">
            <CheckCircle2 className="w-3 h-3" /> Approved
          </span>
        );
      case FieldReportStatus.SUBMITTED:
        return (
          <span className="fr-status-pill fr-status-SUBMITTED">
            <Clock className="w-3 h-3" /> Pending Review
          </span>
        );
      case FieldReportStatus.CHANGES_REQUESTED:
        return (
          <span className="fr-status-pill fr-status-CHANGES_REQUESTED">
            <AlertTriangle className="w-3 h-3" /> Changes Requested
          </span>
        );
      case FieldReportStatus.REJECTED:
        return (
          <span className="fr-status-pill fr-status-REJECTED">
            <XCircle className="w-3 h-3" /> Rejected
          </span>
        );
      default:
        return (
          <span className="fr-status-pill fr-status-DRAFT">
            <FileText className="w-3 h-3" /> Draft
          </span>
        );
    }
  };

  // KPI computations
  const totalCount = (myData?.total || 0) + (teamData?.total || 0);
  const pendingCount = teamData?.data?.filter((r) => r.status === FieldReportStatus.SUBMITTED).length || 0;
  const approvedCount =
    (teamData?.data?.filter((r) => r.status === FieldReportStatus.APPROVED).length || 0) +
    (myData?.data?.filter((r) => r.status === FieldReportStatus.APPROVED).length || 0);

  return (
    <DashboardLayout title="Field Reports">
      <div className="field-reports-editorial-wrapper">
        <div className="fr-page">
          {/* Header */}
          <div className="fr-header">
            <div>
              <h1 className="fr-title flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#e8f0ec] text-[#2c5f4a] flex items-center justify-center shrink-0">
                  <Camera className="w-5 h-5" />
                </div>
                <span>Field Reporting</span>
              </h1>
              <p className="fr-subtitle">
                Mobile photo capture, on-site telemetry, and line manager review. High-resolution
                originals are preserved bit-exact with server-generated derivatives.
              </p>
            </div>
            <div className="fr-actions">
              <Link href="/field-reports/settings" className="fr-btn-secondary">
                <SlidersHorizontal className="w-4 h-4" />
                Policy & Delegations
              </Link>
              <Link href="/field-reports/new" className="fr-btn-primary">
                <Plus className="w-4 h-4" />
                New Field Report
              </Link>
            </div>
          </div>

          {/* KPI Stat Cards */}
          <div className="fr-stats-grid">
            <div className="fr-stat-card">
              <div className="fr-stat-header">
                <span className="fr-stat-label">Active Reports</span>
                <div className="fr-stat-icon-badge">
                  <FileText className="w-4 h-4" />
                </div>
              </div>
              <div className="fr-stat-value">{totalCount}</div>
              <div className="fr-stat-sub">Across active scopes</div>
            </div>

            <div className="fr-stat-card">
              <div className="fr-stat-header">
                <span className="fr-stat-label">Pending Review</span>
                <div className="fr-stat-icon-badge" style={{ background: '#fdf6e3', color: '#b8860b' }}>
                  <Clock className="w-4 h-4" />
                </div>
              </div>
              <div className="fr-stat-value" style={{ color: '#b8860b' }}>{pendingCount}</div>
              <div className="fr-stat-sub">Awaiting line manager action</div>
            </div>

            <div className="fr-stat-card">
              <div className="fr-stat-header">
                <span className="fr-stat-label">Approved Reports</span>
                <div className="fr-stat-icon-badge" style={{ background: '#e8f5ec', color: '#2c7a4e' }}>
                  <Check className="w-4 h-4" />
                </div>
              </div>
              <div className="fr-stat-value" style={{ color: '#2c7a4e' }}>{approvedCount}</div>
              <div className="fr-stat-sub">Compliant and archived</div>
            </div>

            <div className="fr-stat-card">
              <div className="fr-stat-header">
                <span className="fr-stat-label">Offline Outbox</span>
                <div className="fr-stat-icon-badge" style={{ background: '#eef2f8', color: '#4a6fa5' }}>
                  <UploadCloud className="w-4 h-4" />
                </div>
              </div>
              <div className="fr-stat-value">{localDrafts.length}</div>
              <div className="fr-stat-sub">
                {outboxFiles.length} queued upload{outboxFiles.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="fr-tabs" role="tablist">
            {isManagerOrAdmin && (
              <button
                role="tab"
                aria-selected={activeTab === 'team'}
                className={`fr-tab-btn ${activeTab === 'team' ? 'active' : ''}`}
                onClick={() => setActiveTab('team')}
              >
                Team Review Queue
                {teamData?.total !== undefined && teamData.total > 0 && (
                  <span className="fr-tab-badge">{teamData.total}</span>
                )}
              </button>
            )}
            <button
              role="tab"
              aria-selected={activeTab === 'my'}
              className={`fr-tab-btn ${activeTab === 'my' ? 'active' : ''}`}
              onClick={() => setActiveTab('my')}
            >
              My Reports
              {myData?.total !== undefined && myData.total > 0 && (
                <span className="fr-tab-badge">{myData.total}</span>
              )}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'outbox'}
              className={`fr-tab-btn ${activeTab === 'outbox' ? 'active' : ''}`}
              onClick={() => setActiveTab('outbox')}
            >
              Offline Outbox
              {localDrafts.length > 0 && (
                <span className="fr-tab-badge" style={{ background: '#fdf6e3', color: '#b8860b' }}>
                  {localDrafts.length}
                </span>
              )}
            </button>
          </div>

          {/* Team Review Queue Tab */}
          {activeTab === 'team' && isManagerOrAdmin && (
            <div className="space-y-4">
              {/* Filters */}
              <div className="fr-filter-bar">
                <div className="flex-1 min-w-[220px] relative">
                  <input
                    type="text"
                    placeholder="Search by title, employee, or report #..."
                    className="fr-input w-full pl-9"
                    value={teamSearch}
                    onChange={(e) => {
                      setTeamSearch(e.target.value);
                      setTeamPage(1);
                    }}
                  />
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                </div>
                <select
                  className="fr-input"
                  value={teamStatus}
                  onChange={(e) => {
                    setTeamStatus(e.target.value);
                    setTeamPage(1);
                  }}
                >
                  <option value="">All Statuses</option>
                  <option value="SUBMITTED">Pending Review (Submitted)</option>
                  <option value="CHANGES_REQUESTED">Changes Requested</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="DRAFT">Draft</option>
                </select>
                <select
                  className="fr-input"
                  value={teamCategory}
                  onChange={(e) => {
                    setTeamCategory(e.target.value);
                    setTeamPage(1);
                  }}
                >
                  <option value="">All Categories</option>
                  {Object.values(FieldReportCategory).map((cat) => (
                    <option key={cat} value={cat}>
                      {cat.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                {sites && sites.length > 0 && (
                  <select
                    className="fr-input"
                    value={teamSiteId}
                    onChange={(e) => {
                      setTeamSiteId(e.target.value);
                      setTeamPage(1);
                    }}
                  >
                    <option value="">All Sites</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => refetchTeam()}
                  className="fr-btn-secondary"
                  title="Refresh Queue"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              {/* Report Grid */}
              {teamLoading ? (
                <div className="fr-empty">
                  <div className="w-8 h-8 border-2 border-[#2c5f4a] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">Loading reviewer queue...</p>
                </div>
              ) : teamData?.data && teamData.data.length > 0 ? (
                <>
                  <div className="fr-grid">
                    {teamData.data.map((report) => {
                      const currentRev =
                        report.revisions.find((r) => r.revisionNumber === report.currentRevisionNumber) ||
                        report.revisions[0];
                      return (
                        <Link
                          key={report.id}
                          href={`/field-reports/${report.id}`}
                          className="fr-report-card"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2 mb-2.5">
                              <span className="font-mono text-xs font-bold text-slate-500 bg-[#f0eeea] px-2 py-0.5 rounded">
                                {report.reportNumber}
                              </span>
                              {getStatusBadge(report.status)}
                            </div>
                            <h3 className="font-bold text-[#1a1816] text-[15px] mb-1.5 line-clamp-1">
                              {currentRev?.title || 'Untitled Report'}
                            </h3>
                            <div className="flex items-center gap-1.5 text-xs text-[#6b6560] mb-2.5">
                              <User className="w-3.5 h-3.5 text-slate-400" />
                              <span>
                                {report.employee?.firstName} {report.employee?.lastName}
                              </span>
                              {report.employee?.department?.name && (
                                <span className="text-slate-400">({report.employee.department.name})</span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#6b6560]">
                              {report.site?.name && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-slate-400" />
                                  {report.site.name}
                                </span>
                              )}
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3 text-slate-400" />
                                {new Date(report.createdAt).toLocaleDateString()}
                              </span>
                              <span className="fr-category-pill">
                                {report.category.replace(/_/g, ' ')}
                              </span>
                            </div>
                          </div>
                          <div className="mt-4 pt-3 border-t border-[#ece9e4] flex items-center justify-between text-xs text-[#6b6560]">
                            <span>
                              {currentRev?.attachments?.length || 0} attachment
                              {(currentRev?.attachments?.length || 0) === 1 ? '' : 's'}
                            </span>
                            <span className="font-semibold text-[#2c5f4a] flex items-center gap-1">
                              Review report &rarr;
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>

                  {/* Pagination */}
                  {teamData.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-[#e2dfda] pt-4">
                      <span className="text-xs text-[#6b6560]">
                        Page {teamData.page} of {teamData.totalPages} ({teamData.total} reports)
                      </span>
                      <div className="flex gap-2">
                        <button
                          disabled={teamPage <= 1}
                          onClick={() => setTeamPage((p) => Math.max(1, p - 1))}
                          className="fr-btn-secondary"
                        >
                          <ChevronLeft className="w-4 h-4" /> Previous
                        </button>
                        <button
                          disabled={teamPage >= teamData.totalPages}
                          onClick={() => setTeamPage((p) => p + 1)}
                          className="fr-btn-secondary"
                        >
                          Next <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="fr-empty">
                  <ShieldCheck className="w-10 h-10 text-emerald-600 mx-auto mb-2" />
                  <h3 className="fr-empty-title">All caught up!</h3>
                  <p className="fr-empty-sub">
                    There are no pending reports requiring review matching the selected filters.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* My Reports Tab */}
          {activeTab === 'my' && (
            <div className="space-y-4">
              {/* Filters */}
              <div className="fr-filter-bar">
                <div className="flex-1 min-w-[220px] relative">
                  <input
                    type="text"
                    placeholder="Search your reports..."
                    className="fr-input w-full pl-9"
                    value={mySearch}
                    onChange={(e) => {
                      setMySearch(e.target.value);
                      setMyPage(1);
                    }}
                  />
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                </div>
                <select
                  className="fr-input"
                  value={myStatus}
                  onChange={(e) => {
                    setMyStatus(e.target.value);
                    setMyPage(1);
                  }}
                >
                  <option value="">All Statuses</option>
                  <option value="DRAFT">Draft</option>
                  <option value="SUBMITTED">Pending Review</option>
                  <option value="CHANGES_REQUESTED">Changes Requested</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                </select>
                <select
                  className="fr-input"
                  value={myCategory}
                  onChange={(e) => {
                    setMyCategory(e.target.value);
                    setMyPage(1);
                  }}
                >
                  <option value="">All Categories</option>
                  {Object.values(FieldReportCategory).map((cat) => (
                    <option key={cat} value={cat}>
                      {cat.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => refetchMy()}
                  className="fr-btn-secondary"
                  title="Refresh"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              {/* Grid */}
              {myLoading ? (
                <div className="fr-empty">
                  <div className="w-8 h-8 border-2 border-[#2c5f4a] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">Loading your reports...</p>
                </div>
              ) : myData?.data && myData.data.length > 0 ? (
                <>
                  <div className="fr-grid">
                    {myData.data.map((report) => {
                      const currentRev =
                        report.revisions.find((r) => r.revisionNumber === report.currentRevisionNumber) ||
                        report.revisions[0];
                      return (
                        <Link
                          key={report.id}
                          href={`/field-reports/${report.id}`}
                          className="fr-report-card"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2 mb-2.5">
                              <span className="font-mono text-xs font-bold text-slate-500 bg-[#f0eeea] px-2 py-0.5 rounded">
                                {report.reportNumber}
                              </span>
                              {getStatusBadge(report.status)}
                            </div>
                            <h3 className="font-bold text-[#1a1816] text-[15px] mb-1.5 line-clamp-1">
                              {currentRev?.title || 'Untitled Report'}
                            </h3>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#6b6560] mb-2.5">
                              {report.site?.name && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3 text-slate-400" />
                                  {report.site.name}
                                </span>
                              )}
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3 text-slate-400" />
                                {new Date(report.createdAt).toLocaleDateString()}
                              </span>
                              <span className="fr-category-pill">
                                {report.category.replace(/_/g, ' ')}
                              </span>
                            </div>
                          </div>
                          <div className="mt-4 pt-3 border-t border-[#ece9e4] flex items-center justify-between text-xs text-[#6b6560]">
                            <span>
                              {currentRev?.attachments?.length || 0} attachment
                              {(currentRev?.attachments?.length || 0) === 1 ? '' : 's'}
                            </span>
                            <span className="font-semibold text-[#2c5f4a] flex items-center gap-1">
                              View report &rarr;
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>

                  {/* Pagination */}
                  {myData.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-[#e2dfda] pt-4">
                      <span className="text-xs text-[#6b6560]">
                        Page {myData.page} of {myData.totalPages} ({myData.total} reports)
                      </span>
                      <div className="flex gap-2">
                        <button
                          disabled={myPage <= 1}
                          onClick={() => setMyPage((p) => Math.max(1, p - 1))}
                          className="fr-btn-secondary"
                        >
                          <ChevronLeft className="w-4 h-4" /> Previous
                        </button>
                        <button
                          disabled={myPage >= myData.totalPages}
                          onClick={() => setMyPage((p) => p + 1)}
                          className="fr-btn-secondary"
                        >
                          Next <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="fr-empty">
                  <Camera className="w-10 h-10 text-slate-400 mx-auto mb-2" />
                  <h3 className="fr-empty-title">No field reports yet</h3>
                  <p className="fr-empty-sub">
                    Capture mobile photos, notes, and documents from the field.
                  </p>
                  <Link href="/field-reports/new" className="fr-btn-primary">
                    <Plus className="w-4 h-4" />
                    Create New Report
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Offline Outbox Tab */}
          {activeTab === 'outbox' && (
            <div className="space-y-4">
              <div className="bg-[#f0eeea] border border-[#e2dfda] rounded-xl p-4 text-xs text-[#4a4642] leading-relaxed">
                <strong>Client-Side Offline Outbox:</strong> Drafts and media captured in low or no-connectivity
                zones are held securely in your browser&apos;s IndexedDB sandbox. Once network connectivity is detected,
                background chunk synchronization activates automatically without caching API responses.
              </div>

              {loadingOutbox ? (
                <div className="fr-empty">
                  <div className="w-8 h-8 border-2 border-[#2c5f4a] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">Reading offline storage...</p>
                </div>
              ) : localDrafts.length === 0 && outboxFiles.length === 0 ? (
                <div className="fr-empty">
                  <UploadCloud className="w-10 h-10 text-slate-400 mx-auto mb-2" />
                  <h3 className="fr-empty-title">Outbox is clear</h3>
                  <p className="fr-empty-sub">
                    All local drafts and captured media have been successfully synchronized.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {localDrafts.map((draft) => {
                    const draftFiles = outboxFiles.filter((f) => f.localDraftId === draft.localId);
                    return (
                      <div key={draft.localId} className="fr-stat-card p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="fr-status-pill fr-status-DRAFT">Local Draft</span>
                              <span className="text-xs text-[#8a857f]">
                                Saved {new Date(draft.updatedAt).toLocaleTimeString()}
                              </span>
                            </div>
                            <h3 className="text-base font-bold text-[#1a1816]">{draft.title || 'Untitled Draft'}</h3>
                            <p className="text-xs text-[#6b6560] line-clamp-2 mt-1">{draft.notes || 'No description'}</p>
                          </div>
                          <button
                            onClick={() => handleDeleteDraft(draft.localId)}
                            className="fr-btn-danger p-2"
                            title="Delete Draft"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {draftFiles.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-[#ece9e4] space-y-2">
                            <h4 className="text-xs font-bold text-[#4a4642] uppercase">
                              Queued Media ({draftFiles.length})
                            </h4>
                            <div className="space-y-1.5">
                              {draftFiles.map((f) => {
                                const percent = Math.min(100, Math.round((f.uploadedBytes / f.byteSize) * 100));
                                return (
                                  <div
                                    key={f.clientCaptureId}
                                    className="flex items-center justify-between p-2.5 rounded-lg bg-[#faf9f7] border border-[#e2dfda] text-xs"
                                  >
                                    <span className="font-medium text-[#1a1816] truncate max-w-[200px]">
                                      {f.fileName}
                                    </span>
                                    <div className="flex items-center gap-3">
                                      <span className="text-[#8a857f] font-mono">
                                        {(f.byteSize / (1024 * 1024)).toFixed(1)} MB
                                      </span>
                                      {f.status === 'FAILED' ? (
                                        <button
                                          type="button"
                                          onClick={async (e) => {
                                            e.stopPropagation();
                                            await updateOutboxFile(f.clientCaptureId, {
                                              status: 'QUEUED',
                                              sessionId: undefined,
                                              uploadedBytes: 0,
                                            });
                                            if (typeof window !== 'undefined') {
                                              window.dispatchEvent(new Event('online'));
                                            }
                                            loadOutboxData();
                                          }}
                                          className="px-2 py-0.5 rounded text-[11px] font-bold bg-red-100 hover:bg-red-200 text-red-800 transition-colors cursor-pointer"
                                          title="Click to retry file upload"
                                        >
                                          FAILED &bull; Retry
                                        </button>
                                      ) : (
                                        <span
                                          className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                            f.status === 'SYNCED'
                                              ? 'bg-emerald-100 text-emerald-800'
                                              : f.status === 'UPLOADING'
                                              ? 'bg-amber-100 text-amber-800'
                                              : 'bg-slate-200 text-slate-700'
                                          }`}
                                        >
                                          {f.status === 'UPLOADING' ? `${percent}%` : f.status}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
