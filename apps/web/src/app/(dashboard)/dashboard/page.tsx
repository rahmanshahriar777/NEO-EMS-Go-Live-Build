'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { useAuth } from '../../../context/auth-context';
import { api } from '../../../lib/api-client';
import { useDashboardKpis, useMyAttendanceTodayQuery, attendanceKeys } from '../../../lib/queries';
import { SkeletonStatCard } from '../../../components/ui/skeleton';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { formatAppTime, formatAppDate, timezoneLabel, formatCurrency } from '../../../lib/date-utils';
import '../../../styles/dashboard.css';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const STATUS_COLORS: Record<string, string> = {
  FULL_TIME: '#2c7a4e',
  PART_TIME: '#0e7490',
  CONTRACT: '#b45309',
  PROBATION: '#7c3aed',
  INTERN: '#64748b',
  PRESENT: '#2c7a4e',
  LATE: '#b45309',
  ABSENT: '#e11d48',
  HALF_DAY: '#0e7490',
  ON_LEAVE: '#7c3aed',
};

function colorFor(status: string): string {
  return STATUS_COLORS[status.toUpperCase()] || '#64748b';
}

/** Horizontal bar chart rendered as pure SVG/CSS — no data is ever invented. */
function BarChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="kpi-chart">
      {data.map((d) => (
        <div key={d.label} className="kpi-bar-row">
          <span className="kpi-bar-label" title={d.label}>
            {d.label.replace(/_/g, ' ')}
          </span>
          <div className="kpi-bar-track">
            <div
              className="kpi-bar-fill"
              style={{ width: `${(d.value / max) * 100}%`, background: colorFor(d.label) }}
            />
          </div>
          <span className="kpi-bar-value">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Donut chart (SVG arcs) for attendance-today distribution. */
function DonutChart({ data }: { data: Array<{ label: string; value: number }> }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="kpi-donut-wrap">
      <svg viewBox="0 0 140 140" className="kpi-donut" role="img" aria-label="Attendance distribution">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#f0eeea" strokeWidth="18" />
        {data.map((d) => {
          const frac = total > 0 ? d.value / total : 0;
          const dash = `${frac * C} ${C - frac * C}`;
          const el = (
            <circle
              key={d.label}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={colorFor(d.label)}
              strokeWidth="18"
              strokeDasharray={dash}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 70 70)"
              strokeLinecap="butt"
            />
          );
          offset += frac;
          return el;
        })}
        <text x="70" y="66" textAnchor="middle" className="kpi-donut-total">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" className="kpi-donut-caption">
          marked
        </text>
      </svg>
      <div className="kpi-legend">
        {data.map((d) => (
          <div key={d.label} className="kpi-legend-item">
            <span className="kpi-legend-dot" style={{ background: colorFor(d.label) }} />
            <span>{d.label.replace(/_/g, ' ')}</span>
            <strong>{d.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  // Go-live Phase 3 item 7: React Query owns the KPI server state (caching,
  // refetch, error) instead of ad-hoc useState/useEffect.
  const { data: kpis, isPending: loading, error: queryError, refetch } = useDashboardKpis();
  const error = queryError ? (queryError as Error).message || 'Could not load dashboard KPIs.' : null;
  const queryClient = useQueryClient();
  const { data: attendanceData } = useMyAttendanceTodayQuery();
  const [clockError, setClockError] = useState<string | null>(null);
  const [clockBusy, setClockBusy] = useState(false);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const clockStatus = useMemo<'IDLE' | 'CLOCKED_IN' | 'CLOCKED_OUT'>(() => {
    if (!attendanceData?.items) return 'IDLE';
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    const record = attendanceData.items.find((r: any) => String(r.date || '').split('T')[0] === key);
    if (record?.clockInTime && !record?.clockOutTime) {
      return 'CLOCKED_IN';
    } else if (record?.clockOutTime) {
      return 'CLOCKED_OUT';
    }
    return 'IDLE';
  }, [attendanceData]);

  const handleClockAction = async () => {
    setClockBusy(true);
    setClockError(null);
    try {
      if (clockStatus === 'CLOCKED_IN') {
        await api.post('/attendance/clock-out', { notes: 'Clock out from dashboard' });
      } else {
        await api.post('/attendance/clock-in', { notes: 'Clock in from dashboard' });
      }
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    } catch (err: any) {
      setClockError(err?.message || 'Clock action failed. Your shift state was not changed.');
    } finally {
      setClockBusy(false);
    }
  };

  const displayName = user?.firstName || 'there';
  const scopeLabel =
    kpis?.scope === 'company' ? 'Company-wide' : kpis?.scope === 'team' ? 'Your team' : 'Personal';

  return (
    <DashboardLayout title="Executive Workforce Dashboard">
      <div className="dashboard-editorial-wrapper">
        <div className="dash-page">
          <div className="welcome-section">
            <div className="welcome-row">
              <div>
                <h1 className="welcome-greeting">Welcome back, {displayName}</h1>
                <p className="welcome-subtitle">
                  Live KPIs from the dashboard API
                  {kpis && (
                    <>
                      {' '}— scope: <strong>{scopeLabel}</strong>
                      <span className="welcome-date" style={{ marginLeft: '8px' }}>
                        updated {formatAppTime(new Date(kpis.generatedAt))}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="welcome-meta">
                <span className="welcome-date">{formatAppDate(now)}</span>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ marginBottom: '16px' }}>
              <ErrorBanner
                resource="dashboard KPIs"
                detail={error}
                onRetry={() => refetch()}
                retrying={loading}
              />
            </div>
          )}

          {/* Role-aware KPI cards — GET /dashboard/kpis, null = outside scope.
              The grid is the polite live region: screen readers are told once
              when the KPIs land instead of per-card. */}
          <div className="kpi-grid" aria-live="polite" aria-label="Key performance indicators">
            {loading ? (
              <>
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
                <SkeletonStatCard />
              </>
            ) : (
              <>
            <div className="kpi-card">
              <div className="kpi-label">Total Headcount</div>
              <div className="kpi-value">
                {kpis?.headcount ? kpis.headcount.total : '—'}
              </div>
              <div className="kpi-context">
                {kpis?.headcount ? 'Active employees (company scope)' : 'Outside your scope'}
              </div>
              {kpis?.headcount && (
                <BarChart
                  data={Object.entries(kpis.headcount.byStatus).map(([label, value]) => ({
                    label,
                    value,
                  }))}
                />
              )}
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Attendance Today</div>
              <div className="kpi-value">
                {kpis?.attendanceToday ? kpis.attendanceToday.date : '—'}
              </div>
              <div className="kpi-context">
                {kpis?.attendanceToday ? 'Marked punches by status' : 'No attendance data'}
              </div>
              {kpis?.attendanceToday && (
                <DonutChart
                  data={[
                    { label: 'PRESENT', value: kpis.attendanceToday.present },
                    { label: 'LATE', value: kpis.attendanceToday.late },
                    { label: 'HALF_DAY', value: kpis.attendanceToday.halfDay },
                    { label: 'ABSENT', value: kpis.attendanceToday.absent },
                    { label: 'ON_LEAVE', value: kpis.attendanceToday.onLeave },
                  ]}
                />
              )}
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Pending Approvals</div>
              <div className="kpi-value">
                {kpis?.pendingApprovals ? kpis.pendingApprovals.total : '—'}
              </div>
              <div className="kpi-context">
                {kpis?.pendingApprovals
                  ? `Leave requests awaiting decision (${scopeLabel.toLowerCase()})`
                  : 'No approval data'}
              </div>
              {kpis?.pendingApprovals && kpis.pendingApprovals.total > 0 && (
                <Link href="/leaves" className="section-link" style={{ marginTop: '8px', display: 'inline-block' }}>
                  Review leave requests →
                </Link>
              )}
            </div>

            <div className="kpi-card">
              <div className="kpi-label">My Leave Balance</div>
              <div className="kpi-value">
                {kpis?.leaveBalances
                  ? `${kpis.leaveBalances.reduce((s, b) => s + b.remaining, 0)} days`
                  : '—'}
              </div>
              <div className="kpi-context">
                {kpis?.leaveBalances?.length
                  ? 'Remaining across leave types'
                  : 'No leave balances on file'}
              </div>
              {kpis?.leaveBalances && kpis.leaveBalances.length > 0 && (
                <BarChart
                  data={kpis.leaveBalances.map((b) => ({ label: b.code || b.leaveType, value: b.remaining }))}
                />
              )}
            </div>

            <div className="kpi-card">
              <div className="kpi-label">Payroll Cost</div>
              <div className="kpi-value" style={{ fontSize: '22px' }}>
                {kpis?.payrollCost
                  ? formatCurrency(kpis.payrollCost.totalNet)
                  : '—'}
              </div>
              <div className="kpi-context">
                {kpis?.payrollCost
                  ? `${MONTH_NAMES[kpis.payrollCost.month - 1]} ${kpis.payrollCost.year} net · ${kpis.payrollCost.payslipCount} payslips · ${kpis.payrollCost.status}`
                  : 'Outside your scope'}
              </div>
            </div>
              </>
            )}
          </div>

          {/* Bottom Grid: Clock + Quick Actions */}
          <div className="bottom-grid">
            <div className="clock-card">
              <span className="clock-label">Daily Time Clock</span>
              <div className="clock-time-display">{formatAppTime(now)}</div>
              <div className="clock-period">{formatAppDate(now)}</div>
              <span className="clock-timezone">{timezoneLabel()}</span>
              <div className="clock-divider" />
              <div className="clock-status">
                <span className={`clock-status-dot ${clockStatus === 'CLOCKED_IN' ? 'active' : ''}`} />
                {clockStatus === 'CLOCKED_IN'
                  ? 'Currently clocked in for today'
                  : clockStatus === 'CLOCKED_OUT'
                  ? 'Clocked out for today'
                  : 'Ready to begin your working hours'}
              </div>
              {clockError && (
                <div role="alert" style={{ fontSize: '12px', color: '#f43f5e', marginBottom: '8px' }}>
                  {clockError}
                </div>
              )}
              <button
                className={`clock-action-btn ${clockStatus === 'CLOCKED_IN' ? 'clocked-in' : ''}`}
                onClick={handleClockAction}
                disabled={clockBusy}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {clockStatus === 'CLOCKED_IN' ? 'Clock Out for Today' : 'Clock In for Today'}
              </button>
              <Link href="/attendance" className="section-link" style={{ marginTop: '10px', display: 'inline-block', fontSize: '12px' }}>
                Location-checked clock-in →
              </Link>
            </div>

            <div className="actions-card">
              <div className="actions-header">
                <div>
                  <div className="actions-title">Quick Actions</div>
                  <div className="actions-subtitle">Common workforce management tasks</div>
                </div>
                <Link href="/employees" className="section-link">View all</Link>
              </div>
              <div className="actions-grid">
                <Link href="/employees" className="action-item">
                  <div className="action-info">
                    <span className="action-name">Employee Directory</span>
                    <span className="action-desc">Profiles & org structure</span>
                  </div>
                </Link>
                <Link href="/leaves" className="action-item">
                  <div className="action-info">
                    <span className="action-name">Leave Requests</span>
                    <span className="action-desc">Apply & approve leaves</span>
                  </div>
                </Link>
                <Link href="/payroll" className="action-item">
                  <div className="action-info">
                    <span className="action-name">Payroll Runs</span>
                    <span className="action-desc">Approve & disburse</span>
                  </div>
                </Link>
                <Link href="/documents" className="action-item">
                  <div className="action-info">
                    <span className="action-name">Documents</span>
                    <span className="action-desc">Vault & policies</span>
                  </div>
                </Link>
                <Link href="/performance" className="action-item">
                  <div className="action-info">
                    <span className="action-name">Performance</span>
                    <span className="action-desc">Cycles & reviews</span>
                  </div>
                </Link>
                <Link href="/admin/audit-logs" className="action-item">
                  <div className="action-info">
                    <span className="action-name">View Audit Log</span>
                    <span className="action-desc">System activity trail</span>
                  </div>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
