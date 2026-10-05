'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ClipboardList, RefreshCw, Users } from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { SkeletonCardGrid } from '../../../components/ui/skeleton';
import { formatAppDate } from '../../../lib/date-utils';
import '../../../styles/rostering.css';

interface RosterEntry {
  id: string;
  date: string;
  employeeName: string;
  employeeNumber?: string;
  shift?: string;
  departmentName?: string;
  /** Phase 3 item 1 (multi-entity): shown when the API provides it. */
  entityName?: string;
}

/**
 * ASSUMPTION: the rostering API worker defines GET /rostering?from&to.
 * We accept a bare array or {items:[...]} and read common keys tolerantly;
 * anything unrecognized is omitted rather than invented.
 */
function normalizeRoster(res: any): RosterEntry[] {
  const raw: any[] = Array.isArray(res) ? res : res?.items || [];
  return raw
    .map((r, i) => {
      const date: string = r.date || r.day || r.shiftDate || r.startDate || '';
      return {
        id: String(r.id ?? `roster-${i}`),
        date: String(date),
        employeeName:
          r.employeeName ||
          (r.employee ? `${r.employee.firstName || ''} ${r.employee.lastName || ''}`.trim() : undefined) ||
          'Unassigned',
        employeeNumber: r.employeeNumber || r.employee?.employeeNumber || undefined,
        shift: r.shift || r.shiftName || r.shiftType || undefined,
        departmentName: r.departmentName || r.department?.name || undefined,
        // Multi-entity (Phase 3 item 1): rendered when the API ships entities.
        entityName: r.entityName || r.siteName || r.entity?.name || r.site?.name || undefined,
      };
    })
    .filter((r) => r.date);
}

function weekRange(offsetWeeks: number): { from: string; to: string } {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(monday), to: fmt(sunday) };
}

export default function RosteringPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to } = weekRange(weekOffset);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/rostering', { params: { from, to } });
      setEntries(normalizeRoster(res));
    } catch (err: any) {
      setError(err?.message || 'Failed to load roster.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchRoster();
  }, [fetchRoster]);

  const byDay = useMemo(() => {
    const map = new Map<string, RosterEntry[]>();
    for (const e of entries) {
      const key = e.date.split('T')[0];
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [entries]);

  const days: string[] = useMemo(() => {
    const out: string[] = [];
    const d = new Date(from);
    for (let i = 0; i < 7; i++) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [from]);

  const totalAssignments = entries.length;

  return (
    <DashboardLayout title="Shift Rostering">
      <div className="roster-page">
        <header className="roster-header">
          <div>
            <h1 className="roster-title">Shift Rostering</h1>
            <p className="roster-subtitle">
              Week of {formatAppDate(new Date(from))} — {formatAppDate(new Date(to))} • {totalAssignments}{' '}
              {totalAssignments === 1 ? 'assignment' : 'assignments'}
            </p>
          </div>
          <div className="roster-nav">
            <button onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week" className="roster-nav-btn">
              ← Prev
            </button>
            <button onClick={() => setWeekOffset(0)} className="roster-nav-btn">
              This week
            </button>
            <button onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week" className="roster-nav-btn">
              Next →
            </button>
          </div>
        </header>

        {error && (
          <div style={{ marginBottom: '16px' }}>
            <ErrorBanner
              resource="roster"
              detail={error}
              onRetry={fetchRoster}
              retrying={loading}
            />
          </div>
        )}

        {loading ? (
          <SkeletonCardGrid cards={7} />
        ) : entries.length === 0 && !error ? (
          <div className="roster-empty">
            <Users className="w-8 h-8 mx-auto text-slate-400 mb-2" />
            <h3>No roster assignments for this week</h3>
            <p>Roster entries are created by the rostering API for this date range.</p>
          </div>
        ) : (
          <div className="roster-grid">
            {days.map((day) => {
              const dayEntries = byDay.get(day) || [];
              return (
                <div key={day} className="roster-day-card">
                  <div className="roster-day-header">
                    <span className="roster-day-name">
                      {new Date(day).toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                    <span className="roster-day-date">{formatAppDate(new Date(day))}</span>
                  </div>
                  <div className="roster-day-list">
                    {dayEntries.length === 0 ? (
                      <span className="roster-day-empty">—</span>
                    ) : (
                      dayEntries.map((e) => (
                        <div key={e.id} className="roster-entry">
                          <div className="roster-entry-name">{e.employeeName}</div>
                          <div className="roster-entry-meta">
                            {[e.shift, e.departmentName, e.entityName, e.employeeNumber].filter(Boolean).join(' • ')}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="roster-note">
          <ClipboardList className="w-3.5 h-3.5" />
          Roster data is read-only here; shift creation and assignment are managed by the rostering API.
        </p>
      </div>
    </DashboardLayout>
  );
}
