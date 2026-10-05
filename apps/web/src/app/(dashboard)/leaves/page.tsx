'use client';

import React, { useState, useMemo } from 'react';
import {
  CalendarDays,
  Plus,
  Check,
  X,
  Search,
  Plane,
  HeartPulse,
  Coffee,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useLeavePage, leaveKeys, LeaveRequest } from '../../../lib/queries';
import { SkeletonTable, SkeletonStatCard } from '../../../components/ui/skeleton';
import { LeaveRequestForm } from '../../../components/leaves/leave-request-form';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { PaginationControls } from '../../../components/ui/pagination';
import { useAuth } from '../../../context/auth-context';
import { useQueryClient } from '@tanstack/react-query';
import { SystemRole } from '@ems/shared';
import '../../../styles/leaves.css';

export default function LeavesPage() {
  const { user, hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  const [actionError, setActionError] = useState<string | null>(null);

  const PAGE_SIZE = 12;

  // Go-live Phase 3 item 7: React Query owns the leave server state
  // (requests + balances + types) instead of ad-hoc useState/useEffect.
  const {
    data,
    isPending: loading,
    error: queryError,
    refetch,
  } = useLeavePage(page, PAGE_SIZE);
  // NOTE: no mock fallbacks — an API failure shows a loud error, not invented data.
  const error = queryError ? (queryError as Error).message || 'Failed to load leave data.' : null;
  const leaveRequests: LeaveRequest[] = data?.requests.items ?? [];
  const balances = data?.balances ?? [];
  const leaveTypes = data?.types ?? [];
  const total = data?.requests.total ?? 0;

  const handleLeaveSubmitted = async () => {
    setShowApplyModal(false);
    setPage(1);
    await queryClient.invalidateQueries({ queryKey: leaveKeys.all });
  };

  const handleApproveReject = async (id: string, action: 'approve' | 'reject') => {
    const remarks = prompt(`Enter optional remarks for ${action.toUpperCase()}:`) || 'Actioned by manager';
    setActionError(null);
    try {
      await api.patch(`/leave-requests/${id}/${action}`, { remarks });
      await queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    } catch (err: any) {
      setActionError(err?.message || `Failed to ${action} leave request.`);
    }
  };

  // Filtered requests
  const filteredRequests = useMemo(() => {
    return leaveRequests.filter((req) => {
      const matchStatus = statusFilter === 'ALL' || req.status === statusFilter;
      const q = search.toLowerCase().trim();
      const applicantName = `${req.employee?.firstName || ''} ${req.employee?.lastName || ''}`.toLowerCase();
      const empCode = (req.employee?.employeeNumber || '').toLowerCase();
      const leaveType = (req.leaveType?.name || '').toLowerCase();
      const matchSearch =
        !q ||
        applicantName.includes(q) ||
        empCode.includes(q) ||
        leaveType.includes(q) ||
        req.reason.toLowerCase().includes(q);
      return matchStatus && matchSearch;
    });
  }, [leaveRequests, statusFilter, search]);

  // Aggregate balance
  const totalRemainingDays = useMemo(() => {
    return balances.reduce((acc, curr) => acc + curr.remainingDays, 0);
  }, [balances]);

  const pendingCount = useMemo(() => {
    return leaveRequests.filter((r) => r.status === 'PENDING').length;
  }, [leaveRequests]);

  const approvedCount = useMemo(() => {
    return leaveRequests.filter((r) => r.status === 'APPROVED').length;
  }, [leaveRequests]);

  const rejectedCount = useMemo(() => {
    return leaveRequests.filter((r) => r.status === 'REJECTED').length;
  }, [leaveRequests]);

  const getBalanceIcon = (name: string = '') => {
    const n = name.toUpperCase();
    if (n.includes('ANNUAL') || n.includes('PAID')) return Plane;
    if (n.includes('SICK') || n.includes('MEDICAL')) return HeartPulse;
    if (n.includes('CASUAL') || n.includes('PERSONAL')) return Coffee;
    return CalendarDays;
  };

  return (
    <DashboardLayout title="Paid Time Off & Leaves">
      <div className="leaves-editorial-wrapper">
        <div className="leave-page">
          {/* Header Section */}
          <header className="leave-header">
            <div className="leave-header-top">
              <div>
                <h1 className="leave-title">Paid Time Off & Leaves</h1>
                <p className="leave-subtitle">
                  Entitlement telemetry, self-service leave requests, and workforce availability across Neoteric Digital.
                </p>
              </div>

              <div className="leave-header-actions">
                <div className="leave-stat-pill">
                  <span>Total Available</span>
                  <span className="count">{error ? '—' : `${totalRemainingDays} Days`}</span>
                </div>

                <button onClick={() => setShowApplyModal(true)} className="leave-btn-primary">
                  <Plus className="w-4 h-4" />
                  <span>Request Leave</span>
                </button>
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: '16px' }}>
                <ErrorBanner
                  resource="leave data"
                  detail={error}
                  onRetry={() => refetch()}
                  retrying={loading}
                />
              </div>
            )}

            {actionError && (
              <div
                role="alert"
                style={{
                  marginBottom: '16px',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(244, 63, 94, 0.08)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  color: '#f43f5e',
                  fontSize: '13px',
                }}
              >
                {actionError}
              </div>
            )}

            {/* Balances Entitlements Cards — real API data only */}
            <div className="leave-balances-grid" aria-live="polite" aria-label="Leave balances">
              {loading ? (
                <>
                  <SkeletonStatCard />
                  <SkeletonStatCard />
                  <SkeletonStatCard />
                </>
              ) : (
                balances.map((b, i) => {
                const IconComponent = getBalanceIcon(b.leaveType?.name);
                const percent = Math.min(100, Math.round((b.usedDays / (b.allocatedDays || 1)) * 100));
                return (
                  <div key={i} className="leave-balance-card">
                    <div>
                      <div className="leave-balance-header">
                        <span className="leave-balance-title">{b.leaveType?.name || 'Leave Entitlement'}</span>
                        <div className="leave-balance-icon">
                          <IconComponent className="w-4 h-4" />
                        </div>
                      </div>

                      <div className="leave-balance-stat">
                        <span className="leave-balance-remaining">{b.remainingDays}</span>
                        <span className="leave-balance-unit">days remaining</span>
                      </div>

                      <div className="leave-progress-track">
                        <div
                          className="leave-progress-fill"
                          style={{
                            width: `${100 - percent}%`,
                            background: b.remainingDays <= 3 ? 'var(--leave-warning)' : 'var(--leave-accent)',
                          }}
                        />
                      </div>
                    </div>

                    <div className="leave-balance-meta">
                      <span>Allocated: {b.allocatedDays}d</span>
                      <span>Used: {b.usedDays || 0}d</span>
                    </div>
                  </div>
                );
              }))}
            </div>
          </header>

          {/* Search & Status Filter Toolbar */}
          <div className="leave-toolbar">
            <div className="leave-search-container">
              <Search className="leave-search-icon" />
              <input
                type="text"
                id="leave-search"
                aria-label="Search leave requests"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search applicants, categories, or reasons..."
                className="leave-search-input"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--leave-text-tertiary)',
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="leave-filter-tabs" role="group" aria-label="Filter by status">
              <button
                onClick={() => setStatusFilter('ALL')}
                className={`leave-tab-btn ${statusFilter === 'ALL' ? 'active' : ''}`}
                aria-pressed={statusFilter === 'ALL'}
              >
                All Requests ({leaveRequests.length})
              </button>
              <button
                onClick={() => setStatusFilter('PENDING')}
                className={`leave-tab-btn ${statusFilter === 'PENDING' ? 'active' : ''}`}
                aria-pressed={statusFilter === 'PENDING'}
              >
                Pending Review ({pendingCount})
              </button>
              <button
                onClick={() => setStatusFilter('APPROVED')}
                className={`leave-tab-btn ${statusFilter === 'APPROVED' ? 'active' : ''}`}
                aria-pressed={statusFilter === 'APPROVED'}
              >
                Approved ({approvedCount})
              </button>
              {rejectedCount > 0 && (
                <button
                  onClick={() => setStatusFilter('REJECTED')}
                  className={`leave-tab-btn ${statusFilter === 'REJECTED' ? 'active' : ''}`}
                  aria-pressed={statusFilter === 'REJECTED'}
                >
                  Rejected ({rejectedCount})
                </button>
              )}
            </div>
          </div>

          {/* Leave Requests Table — polite live region: announced once per update */}
          <div aria-live="polite" aria-label="Leave requests">
          {loading ? (
            <SkeletonTable rows={8} columns={7} />
          ) : filteredRequests.length === 0 ? (
            <div style={{
              padding: '64px 20px',
              textAlign: 'center',
              background: 'var(--leave-surface)',
              border: '1px solid var(--leave-border)',
              borderRadius: 'var(--leave-radius-lg)',
              boxShadow: 'var(--leave-shadow-sm)',
            }}>
              <CalendarDays className="w-8 h-8 mx-auto text-slate-400 mb-2" />
              <h3 style={{ fontFamily: 'var(--leave-font-serif)', fontSize: '20px', color: 'var(--leave-text-primary)' }}>
                No Leave Applications Found
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--leave-text-secondary)', marginTop: '4px' }}>
                There are no leave requests matching your selected filter or search term.
              </p>
              {(search || statusFilter !== 'ALL') && (
                <button
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('ALL');
                  }}
                  className="leave-btn-primary"
                  style={{ marginTop: '16px' }}
                >
                  Reset Filter
                </button>
              )}
            </div>
          ) : (
            <div className="leave-table-wrapper">
              <table className="leave-table">
                <thead>
                  <tr>
                    <th>Applicant</th>
                    <th>Category</th>
                    <th>Window Schedule</th>
                    <th>Duration</th>
                    <th>Reason / Scope</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequests.map((req) => (
                    <tr key={req.id}>
                      <td>
                        <div className="leave-table-user">
                          <div className="leave-user-avatar">
                            {req.employee?.firstName?.[0] || 'E'}
                            {req.employee?.lastName?.[0] || ''}
                          </div>
                          <div>
                            <div className="leave-user-name">
                              {req.employee?.firstName} {req.employee?.lastName}
                            </div>
                            <div className="leave-user-code">
                              {req.employee?.employeeNumber || '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ fontWeight: 500, color: 'var(--leave-text-primary)' }}>
                        {req.leaveType?.name || '—'}
                      </td>
                      <td>
                        <span className="leave-dates-tag">
                          {req.startDate?.split('T')[0]} &rarr; {req.endDate?.split('T')[0]}
                        </span>
                      </td>
                      <td>
                        <span className="leave-days-badge">{req.totalDays}d</span>
                      </td>
                      <td>
                        <div className="leave-reason-text" title={req.reason}>
                          {req.reason}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`leave-status-badge ${
                            req.status === 'APPROVED'
                              ? 'leave-status-approved'
                              : req.status === 'REJECTED'
                              ? 'leave-status-rejected'
                              : 'leave-status-pending'
                          }`}
                        >
                          {req.status}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {req.status === 'PENDING' &&
                        hasRole(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN) ? (
                          <div className="leave-actions-row">
                            <button
                              onClick={() => handleApproveReject(req.id, 'approve')}
                              className="leave-action-btn leave-btn-approve"
                              title="Approve Leave"
                              aria-label={`Approve leave request from ${req.employee?.firstName || ''} ${req.employee?.lastName || ''}`}
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Approve</span>
                            </button>
                            <button
                              onClick={() => handleApproveReject(req.id, 'reject')}
                              className="leave-action-btn leave-btn-reject"
                              title="Reject Leave"
                              aria-label={`Reject leave request from ${req.employee?.firstName || ''} ${req.employee?.lastName || ''}`}
                            >
                              <X className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'var(--leave-text-tertiary)', fontFamily: 'var(--leave-font-mono)' }}>
                            Processed
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>

          {/* Pagination — wired to ?page&limit and the API's {items,total} response */}
          <div style={{ marginTop: '16px' }}>
            <PaginationControls
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </div>
        </div>
      </div>

      {/* Leave Application Modal (react-hook-form) */}
      {showApplyModal && (
        <LeaveRequestForm
          types={leaveTypes}
          onClose={() => setShowApplyModal(false)}
          onSubmitted={handleLeaveSubmitted}
        />
      )}
    </DashboardLayout>
  );
}
