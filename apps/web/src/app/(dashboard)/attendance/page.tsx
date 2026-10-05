'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Clock,
  Calendar,
  Search,
  X,
  TrendingUp,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api, Paginated } from '../../../lib/api-client';
import { useAttendanceListQuery, useAttendanceCorrectionsQuery, attendanceKeys } from '../../../lib/queries';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { PaginationControls } from '../../../components/ui/pagination';
import { SkeletonTable } from '../../../components/ui/skeleton';
import { formatAppTime, timezoneLabel } from '../../../lib/date-utils';
import '../../../styles/attendance.css';

interface AttendanceRecord {
  id: string;
  date: string;
  employee?: {
    id?: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
  };
  clockInTime?: string;
  clockOutTime?: string;
  totalHoursWorked?: number;
  status: 'PRESENT' | 'LATE' | 'ABSENT' | 'HALF_DAY';
  notes?: string;
  location?: string;
  // Break tracking (worker 4 — API extension pending; undefined until then).
  breakMinutes?: number;
  overtimeHours?: number;
}

interface AttendanceCorrection {
  id: string;
  attendanceRecordId: string;
  employee?: { firstName: string; lastName: string; employeeNumber?: string };
  date?: string;
  requestedClockIn?: string;
  requestedClockOut?: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt?: string;
}

const PAGE_SIZE = 15;

/**
 * Overtime is derived client-side: hours worked beyond a standard 8-hour
 * shift. Assumption (BUILD_SPEC Phase 1 refactoring): the platform treats 8h
 * as the standard full-time shift until the API ships real overtime rules.
 * This is a display derivation, not payroll input.
 */
const STANDARD_SHIFT_HOURS = 8;

function overtimeOf(rec: AttendanceRecord): number | null {
  if (typeof rec.overtimeHours === 'number') return rec.overtimeHours;
  if (typeof rec.totalHoursWorked !== 'number' || !isFinite(rec.totalHoursWorked)) return null;
  const ot = rec.totalHoursWorked - STANDARD_SHIFT_HOURS;
  return ot > 0 ? Math.round(ot * 100) / 100 : 0;
}

/** Format a clock timestamp in the configured timezone; tolerate raw strings. */
function formatClockTime(value?: string): string {
  if (!value) return '--:--';
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : formatAppTime(d);
}

/** Format a record date as YYYY-MM-DD; tolerate ISO timestamps. */
function formatRecordDate(value?: string): string {
  if (!value) return '—';
  const datePart = value.split('T')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : value;
}

function isToday(value?: string): boolean {
  if (!value) return false;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return value.split('T')[0] === `${y}-${m}-${d}`;
}

export default function AttendancePage() {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [clocking, setClocking] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'my' | 'team' | 'corrections'>('my');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PRESENT' | 'LATE' | 'ABSENT'>('ALL');
  const [liveTime, setLiveTime] = useState<string>('');

  const listTab = activeTab === 'corrections' ? 'my' : activeTab;
  const {
    data: listData,
    isPending: listLoading,
    error: listQueryError,
    refetch: refetchAttendance,
  } = useAttendanceListQuery(listTab, page, PAGE_SIZE);

  const {
    data: correctionsData,
    isPending: correctionsQueryLoading,
    error: correctionsQueryError,
    refetch: refetchCorrections,
  } = useAttendanceCorrectionsQuery(activeTab === 'corrections');

  const attendanceList: AttendanceRecord[] = listData?.items || [];
  const total = listData?.total || 0;
  const todayRecord = attendanceList.find((r) => isToday(r.date)) || null;
  const loading = activeTab !== 'corrections' && listLoading;
  const error = listQueryError ? (listQueryError as Error).message || 'Failed to load attendance records.' : null;

  const corrections: AttendanceCorrection[] = correctionsData || [];
  const correctionsLoading = activeTab === 'corrections' && correctionsQueryLoading;
  const correctionsError = correctionsQueryError
    ? (correctionsQueryError as Error).message || 'Could not load correction requests.'
    : null;

  // Correction requests (Phase 2 item 5 — API: worker 4)
  const [correcting, setCorrecting] = useState<AttendanceRecord | null>(null);
  const [corrClockIn, setCorrClockIn] = useState('');
  const [corrClockOut, setCorrClockOut] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [corrBusy, setCorrBusy] = useState(false);
  const [corrError, setCorrError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  // Location-checked clock-in (Phase 3 item 7)
  const [locBusy, setLocBusy] = useState(false);
  const [locNotice, setLocNotice] = useState<string | null>(null);

  const isManager = hasRole(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN);

  useEffect(() => {
    const updateTime = () => setLiveTime(formatAppTime(new Date()));
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleClockToggle = async () => {
    setClocking(true);
    setClockError(null);
    const wasClockedIn = Boolean(todayRecord?.clockInTime && !todayRecord?.clockOutTime);
    try {
      // Clock-in honesty: UI state changes ONLY when the API confirms the punch.
      const action = wasClockedIn ? 'clock-out' : 'clock-in';
      await api.post(`/attendance/${action}`, {
        notes: wasClockedIn ? 'Clocked out from attendance portal' : 'Clocked in from attendance portal',
      });
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    } catch (err: any) {
      // On failure: keep the previous state and surface the error inline.
      setClockError(err?.message || 'Clock action failed. Your shift state was not changed.');
    } finally {
      setClocking(false);
    }
  };

  // Location-checked clock-in (Phase 3 item 7). The site's coordinates come
  // from env (NEXT_PUBLIC_SITE_*); the client refuses to punch outside the
  // radius, and the API re-validates the raw coordinates server-side
  // (the API stores `location` on the punch — worker 4 owns coordinate
  // validation). Client gating is UX only, never the trust boundary.
  const handleLocationClockIn = async () => {
    setLocBusy(true);
    setLocNotice(null);
    setClockError(null);
    try {
      const { checkedPosition, formatCoords } = await import('../../../lib/pwa');
      const siteLat = Number(process.env.NEXT_PUBLIC_SITE_LATITUDE);
      const siteLng = Number(process.env.NEXT_PUBLIC_SITE_LONGITUDE);
      const siteRadius = Number(process.env.NEXT_PUBLIC_SITE_RADIUS_METERS || 200);
      if (!isFinite(siteLat) || !isFinite(siteLng)) {
        throw new Error(
          'No site coordinates are configured (NEXT_PUBLIC_SITE_LATITUDE / NEXT_PUBLIC_SITE_LONGITUDE). Ask your administrator to set the site location.',
        );
      }
      const pos = await checkedPosition({
        latitude: siteLat,
        longitude: siteLng,
        radiusMeters: siteRadius,
        siteName: process.env.NEXT_PUBLIC_SITE_NAME || 'the site',
      });
      await api.post('/attendance/clock-in', {
        notes: 'Location-checked clock in from attendance portal',
        location: formatCoords(pos),
      });
      setLocNotice('Clocked in — your device was inside the site radius.');
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    } catch (err: any) {
      setClockError(err?.message || 'Location-checked clock-in failed.');
    } finally {
      setLocBusy(false);
    }
  };

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correcting) return;
    setCorrBusy(true);
    setCorrError(null);
    try {
      // API (worker 4): POST /attendance/corrections
      await api.post('/attendance/corrections', {
        attendanceRecordId: correcting.id,
        requestedClockIn: corrClockIn || undefined,
        requestedClockOut: corrClockOut || undefined,
        reason: corrReason,
      });
      setCorrecting(null);
      setCorrClockIn('');
      setCorrClockOut('');
      setCorrReason('');
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.corrections() });
    } catch (err: any) {
      setCorrError(err?.message || 'Could not submit the correction request.');
    } finally {
      setCorrBusy(false);
    }
  };

  const decideCorrection = async (id: string, approve: boolean) => {
    if (!window.confirm(`${approve ? 'Approve' : 'Reject'} this correction request?`)) return;
    setDeciding(id);
    try {
      // API (worker 4): PATCH /attendance/corrections/:id
      await api.patch(`/attendance/corrections/${id}`, { status: approve ? 'APPROVED' : 'REJECTED' });
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.corrections() });
    } catch (err: any) {
      alert(err?.message || 'Could not decide the correction request.');
    } finally {
      setDeciding(null);
    }
  };

  // Filtered records (client-side over the loaded page)
  const filteredList = useMemo(() => {
    return attendanceList.filter((rec) => {
      const matchStatus = statusFilter === 'ALL' || rec.status === statusFilter;
      const q = search.toLowerCase().trim();
      const empName = `${rec.employee?.firstName || ''} ${rec.employee?.lastName || ''}`.toLowerCase();
      const empCode = (rec.employee?.employeeNumber || '').toLowerCase();
      const notes = (rec.notes || '').toLowerCase();
      const dateStr = (rec.date || '').toLowerCase();
      const matchSearch =
        !q || empName.includes(q) || empCode.includes(q) || notes.includes(q) || dateStr.includes(q);
      return matchStatus && matchSearch;
    });
  }, [attendanceList, statusFilter, search]);

  // Stats computed from real API data only
  const presentCount = attendanceList.filter((r) => r.status === 'PRESENT').length;
  const lateCount = attendanceList.filter((r) => r.status === 'LATE').length;
  const markedCount = attendanceList.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;
  const punctuality = markedCount > 0 ? ((presentCount / markedCount) * 100).toFixed(1) : null;
  const hoursValues = attendanceList
    .map((r) => r.totalHoursWorked)
    .filter((h): h is number => typeof h === 'number' && isFinite(h));
  const avgShift = hoursValues.length > 0 ? (hoursValues.reduce((a, b) => a + b, 0) / hoursValues.length).toFixed(2) : null;

  const isClockedIn = Boolean(todayRecord?.clockInTime && !todayRecord?.clockOutTime);

  return (
    <DashboardLayout title="Daily Attendance Tracker">
      <div className="attendance-editorial-wrapper">
        <div className="att-page">
          {/* Header Section */}
          <header className="att-header">
            <div className="att-header-top">
              <div>
                <h1 className="att-title">Daily Attendance Tracker</h1>
                <p className="att-subtitle">
                  Timesheet records and clock-in status for{' '}
                  {activeTab === 'my' ? 'your own attendance' : 'your team'}.
                </p>
              </div>

              <div className="att-clock-badge">
                <span className="att-clock-dot" />
                <span>
                  {timezoneLabel()}: {liveTime || '—'}
                </span>
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: '16px' }}>
                <ErrorBanner
                  resource="attendance records"
                  detail={error}
                  onRetry={() => refetchAttendance()}
                  retrying={loading}
                />
              </div>
            )}

            {/* Timeclock Hero Widget */}
            <div className="att-hero-widget">
              <div className="att-hero-left">
                <div className="att-hero-icon">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <div className="att-hero-title">
                    <span>Shift Status</span>
                    <span
                      style={{
                        fontFamily: 'var(--att-font-mono)',
                        fontSize: '11px',
                        color: 'var(--att-accent)',
                        background: 'var(--att-accent-light)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                      }}
                    >
                      {timezoneLabel()}
                    </span>
                  </div>
                  <p className="att-hero-desc">
                    Punch state is confirmed by the API — the buttons below only change
                    state when the server records the punch.
                  </p>
                </div>
              </div>

              <div className="att-hero-right">
                <div className="att-status-indicator">
                  <span className="att-status-sublabel">Punch Telemetry</span>
                  <div className="att-status-value">
                    {isClockedIn
                      ? 'Currently Active'
                      : todayRecord?.clockOutTime
                      ? 'Shift Completed'
                      : 'Not Clocked In'}
                  </div>
                </div>

                <button
                  onClick={handleClockToggle}
                  disabled={clocking}
                  className={`att-btn-clock ${isClockedIn ? 'att-btn-clock-out' : 'att-btn-clock-in'}`}
                >
                  <Clock className="w-4 h-4" />
                  <span>{isClockedIn ? 'Clock Out Shift' : 'Clock In Now'}</span>
                </button>

                {!isClockedIn && (
                  <button
                    onClick={handleLocationClockIn}
                    disabled={locBusy}
                    className="att-btn-clock att-btn-clock-in"
                    style={{ marginTop: '8px', opacity: 0.92 }}
                    title="Clock in with device location verification"
                  >
                    <Clock className="w-4 h-4" />
                    <span>{locBusy ? 'Verifying location…' : 'Clock In (Location-Checked)'}</span>
                  </button>
                )}
              </div>
            </div>

            {locNotice && (
              <div
                role="status"
                style={{
                  marginTop: '12px',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(44, 122, 78, 0.08)',
                  border: '1px solid rgba(44, 122, 78, 0.3)',
                  color: '#2c7a4e',
                  fontSize: '13px',
                }}
              >
                {locNotice}
              </div>
            )}

            {clockError && (
              <div
                role="alert"
                style={{
                  marginTop: '12px',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(244, 63, 94, 0.08)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  color: '#f43f5e',
                  fontSize: '13px',
                }}
              >
                Clock action failed: {clockError} Your previous shift state is unchanged.
              </div>
            )}

            {/* 4 Quick Stat Cards — computed from real API data only */}
            <div className="att-quick-stats">
              <div className="att-quick-stat-card">
                <div>
                  <div className="att-quick-stat-label">Logged Days</div>
                  <div className="att-quick-stat-value">
                    {error ? '—' : `${total} ${total === 1 ? 'Day' : 'Days'}`}
                  </div>
                </div>
                <div className="att-quick-stat-icon">
                  <Calendar className="w-5 h-5" />
                </div>
              </div>

              <div className="att-quick-stat-card">
                <div>
                  <div className="att-quick-stat-label">Punctuality Rate</div>
                  <div className="att-quick-stat-value">
                    {error || punctuality === null ? '—' : `${punctuality}%`}
                  </div>
                </div>
                <div className="att-quick-stat-icon">
                  <TrendingUp className="w-5 h-5" />
                </div>
              </div>

              <div className="att-quick-stat-card">
                <div>
                  <div className="att-quick-stat-label">Average Shift</div>
                  <div className="att-quick-stat-value">
                    {error || avgShift === null ? '—' : `${avgShift} hrs`}
                  </div>
                </div>
                <div className="att-quick-stat-icon">
                  <Timer className="w-5 h-5" />
                </div>
              </div>

              <div className="att-quick-stat-card">
                <div>
                  <div className="att-quick-stat-label">Late Marks</div>
                  <div className="att-quick-stat-value">{error ? '—' : lateCount}</div>
                </div>
                <div className="att-quick-stat-icon">
                  <ShieldCheck className="w-5 h-5" />
                </div>
              </div>
            </div>
          </header>

          {/* Search & Tabs Toolbar */}
          <div className="att-toolbar">
            <div className="att-search-container">
              <Search className="att-search-icon" />
              <input
                type="text"
                id="attendance-search"
                aria-label="Search attendance records"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dates, shift notes, or team personnel..."
                className="att-search-input"
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
                    color: 'var(--att-text-tertiary)',
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="att-filter-tabs">
              <button
                onClick={() => setActiveTab('my')}
                className={`att-tab-btn ${activeTab === 'my' ? 'active' : ''}`}
              >
                My Timesheet
              </button>

              {isManager && (
                <button
                  onClick={() => setActiveTab('team')}
                  className={`att-tab-btn ${activeTab === 'team' ? 'active' : ''}`}
                >
                  Team Timesheet (Manager)
                </button>
              )}

              {isManager && (
                <button
                  onClick={() => setActiveTab('corrections')}
                  className={`att-tab-btn ${activeTab === 'corrections' ? 'active' : ''}`}
                >
                  Correction Requests
                </button>
              )}

              <div style={{ width: '1px', height: '16px', background: 'var(--att-border)', margin: '0 4px' }} />

              <button
                onClick={() => setStatusFilter('ALL')}
                className={`att-tab-btn ${statusFilter === 'ALL' ? 'active' : ''}`}
              >
                All Status
              </button>
              <button
                onClick={() => setStatusFilter('PRESENT')}
                className={`att-tab-btn ${statusFilter === 'PRESENT' ? 'active' : ''}`}
              >
                Present
              </button>
              <button
                onClick={() => setStatusFilter('LATE')}
                className={`att-tab-btn ${statusFilter === 'LATE' ? 'active' : ''}`}
              >
                Late
              </button>
            </div>
          </div>

          {/* Table View */}
          {activeTab === 'corrections' ? (
            <div className="att-table-wrapper">
              {correctionsError && (
                <div style={{ marginBottom: '12px' }}>
                  <ErrorBanner
                    resource="correction requests"
                    detail={correctionsError}
                    onRetry={() => refetchCorrections()}
                    retrying={correctionsLoading}
                  />
                </div>
              )}
              {correctionsLoading ? (
                <SkeletonTable rows={5} columns={5} />
              ) : corrections.length === 0 && !correctionsError ? (
                <div className="att-loading-state" style={{ padding: '48px 20px' }}>
                  <span>No pending correction requests.</span>
                </div>
              ) : (
                <table className="att-table">
                  <thead>
                    <tr>
                      <th>Personnel</th>
                      <th>Date</th>
                      <th>Requested Times</th>
                      <th>Reason</th>
                      <th style={{ textAlign: 'right' }}>Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <div className="att-table-user">
                            <div className="att-user-avatar">
                              {c.employee?.firstName?.[0] || 'E'}
                            </div>
                            <div>
                              <div className="att-user-name">
                                {c.employee?.firstName} {c.employee?.lastName}
                              </div>
                              <span style={{ fontFamily: 'var(--att-font-mono)', fontSize: '10.5px', color: 'var(--att-text-tertiary)' }}>
                                {c.employee?.employeeNumber || '—'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="att-date-col">{formatRecordDate(c.date)}</td>
                        <td className="att-time-col">
                          {c.requestedClockIn ? formatClockTime(c.requestedClockIn) : '—'}
                          {' → '}
                          {c.requestedClockOut ? formatClockTime(c.requestedClockOut) : '—'}
                        </td>
                        <td style={{ fontSize: '12.5px', maxWidth: '260px' }}>{c.reason}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            onClick={() => decideCorrection(c.id, true)}
                            disabled={deciding === c.id}
                            className="att-btn-clock att-btn-clock-in"
                            style={{ marginRight: '8px', padding: '8px 14px', fontSize: '12px' }}
                          >
                            {deciding === c.id ? '…' : 'Approve'}
                          </button>
                          <button
                            onClick={() => decideCorrection(c.id, false)}
                            disabled={deciding === c.id}
                            className="att-btn-clock att-btn-clock-out"
                            style={{ padding: '8px 14px', fontSize: '12px' }}
                          >
                            {deciding === c.id ? '…' : 'Reject'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : loading ? (
            <SkeletonTable rows={6} columns={6} />
          ) : filteredList.length === 0 ? (
            <div
              style={{
                padding: '64px 20px',
                textAlign: 'center',
                background: 'var(--att-surface)',
                border: '1px solid var(--att-border)',
                borderRadius: 'var(--att-radius-lg)',
                boxShadow: 'var(--att-shadow-sm)',
              }}
            >
              <Clock className="w-8 h-8 mx-auto text-slate-400 mb-2" />
              <h3
                style={{
                  fontFamily: 'var(--att-font-serif)',
                  fontSize: '20px',
                  color: 'var(--att-text-primary)',
                }}
              >
                No Attendance Logs Found
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--att-text-secondary)', marginTop: '4px' }}>
                {error
                  ? 'Attendance data could not be loaded.'
                  : 'No records match your query for this timeframe or filter criteria.'}
              </p>
              {search && (
                <button
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('ALL');
                  }}
                  className="att-btn-clock att-btn-clock-in"
                  style={{ marginTop: '16px', display: 'inline-flex' }}
                >
                  Reset Query
                </button>
              )}
            </div>
          ) : (
            <div className="att-table-wrapper">
              <table className="att-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    {activeTab === 'team' && <th>Personnel</th>}
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th>Hours Worked</th>
                    <th>Breaks</th>
                    <th>Overtime</th>
                    <th>Status</th>
                    <th>Shift Notes</th>
                    {activeTab === 'my' && <th style={{ textAlign: 'right' }}>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredList.map((rec) => (
                    <tr key={rec.id}>
                      <td className="att-date-col">{formatRecordDate(rec.date)}</td>

                      {activeTab === 'team' && (
                        <td>
                          <div className="att-table-user">
                            <div className="att-user-avatar">
                              {rec.employee?.firstName?.[0] || 'E'}
                              {rec.employee?.lastName?.[0] || ''}
                            </div>
                            <div>
                              <div className="att-user-name">
                                {rec.employee?.firstName} {rec.employee?.lastName}
                              </div>
                              <span
                                style={{
                                  fontFamily: 'var(--att-font-mono)',
                                  fontSize: '10.5px',
                                  color: 'var(--att-text-tertiary)',
                                }}
                              >
                                {rec.employee?.employeeNumber || '—'}
                              </span>
                            </div>
                          </div>
                        </td>
                      )}

                      <td className="att-time-col">{formatClockTime(rec.clockInTime)}</td>

                      <td className="att-time-col">{formatClockTime(rec.clockOutTime)}</td>

                      <td>
                        <span className="att-hours-badge">
                          {typeof rec.totalHoursWorked === 'number' ? `${rec.totalHoursWorked} hrs` : '--'}
                        </span>
                      </td>

                      <td>
                        <span className="att-hours-badge" title="Break tracking is not yet recorded by the API (worker 4)">
                          {typeof rec.breakMinutes === 'number' ? `${rec.breakMinutes} min` : '—'}
                        </span>
                      </td>

                      <td>
                        {(() => {
                          const ot = overtimeOf(rec);
                          return ot === null ? (
                            <span style={{ color: 'var(--att-text-tertiary)' }}>—</span>
                          ) : ot > 0 ? (
                            <span className="att-hours-badge" style={{ color: '#b45309', fontWeight: 700 }} title={`Over the ${STANDARD_SHIFT_HOURS}h standard shift`}>
                              +{ot} hrs
                            </span>
                          ) : (
                            <span style={{ color: 'var(--att-text-tertiary)' }}>—</span>
                          );
                        })()}
                      </td>

                      <td>
                        <span
                          className={`att-status-badge ${
                            rec.status === 'PRESENT'
                              ? 'att-status-present'
                              : rec.status === 'LATE'
                              ? 'att-status-late'
                              : 'att-status-absent'
                          }`}
                        >
                          {rec.status}
                        </span>
                      </td>

                      <td
                        style={{
                          color: 'var(--att-text-secondary)',
                          fontSize: '12.5px',
                          maxWidth: '260px',
                        }}
                      >
                        {rec.notes || '—'}
                      </td>

                      {activeTab === 'my' && (
                        <td style={{ textAlign: 'right' }}>
                          <button
                            onClick={() => {
                              setCorrecting(rec);
                              setCorrClockIn(rec.clockInTime ? rec.clockInTime.slice(11, 16) : '');
                              setCorrClockOut(rec.clockOutTime ? rec.clockOutTime.slice(11, 16) : '');
                              setCorrReason('');
                              setCorrError(null);
                            }}
                            className="att-tab-btn"
                            title="Request a correction to this record"
                          >
                            Request correction
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination — wired to ?page&limit and the API's {items,total} response */}
          {activeTab !== 'corrections' && (
            <div style={{ marginTop: '16px' }}>
              <PaginationControls
                page={page}
                limit={PAGE_SIZE}
                total={total}
                onPageChange={(p) => setPage(p)}
              />
            </div>
          )}

          {/* Correction request modal */}
          {correcting && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
              onClick={() => setCorrecting(null)}
            >
              <div
                className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-[16px] font-bold text-[#1a1816] mb-1">
                  Request correction — {formatRecordDate(correcting.date)}
                </h3>
                <p className="text-[12.5px] text-slate-500 mb-4">
                  Your manager reviews this. Recorded times:{' '}
                  {formatClockTime(correcting.clockInTime)} → {formatClockTime(correcting.clockOutTime)}.
                </p>
                {corrError && (
                  <div className="mb-4 rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-700" role="alert">
                    {corrError}
                  </div>
                )}
                <form onSubmit={submitCorrection} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[12px] font-semibold text-[#4a4642] mb-1.5" htmlFor="corr-in">
                        Correct clock-in
                      </label>
                      <input
                        id="corr-in"
                        type="time"
                        className="w-full px-3 py-2 border border-[#e2dfda] rounded-[10px] text-[13px]"
                        value={corrClockIn}
                        onChange={(e) => setCorrClockIn(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] font-semibold text-[#4a4642] mb-1.5" htmlFor="corr-out">
                        Correct clock-out
                      </label>
                      <input
                        id="corr-out"
                        type="time"
                        className="w-full px-3 py-2 border border-[#e2dfda] rounded-[10px] text-[13px]"
                        value={corrClockOut}
                        onChange={(e) => setCorrClockOut(e.target.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-[#4a4642] mb-1.5" htmlFor="corr-reason">
                      Reason <span className="text-rose-600">*</span>
                    </label>
                    <textarea
                      id="corr-reason"
                      required
                      rows={3}
                      className="w-full px-3 py-2 border border-[#e2dfda] rounded-[10px] text-[13px]"
                      value={corrReason}
                      onChange={(e) => setCorrReason(e.target.value)}
                      placeholder="e.g. Forgot to clock out at 18:00; left the office on time"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setCorrecting(null)}
                      className="rounded-[10px] border border-[#e2dfda] px-4 py-2 text-[13px] font-semibold text-[#4a4642]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={corrBusy}
                      className="rounded-[10px] bg-[#2c5f4a] px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
                    >
                      {corrBusy ? 'Submitting…' : 'Submit request'}
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
