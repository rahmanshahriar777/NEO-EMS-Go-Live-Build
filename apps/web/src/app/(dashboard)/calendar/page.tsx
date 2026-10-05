'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useCalendarEventsQuery } from '../../../lib/queries';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { Skeleton } from '../../../components/ui/skeleton';
import { formatAppDate } from '../../../lib/date-utils';
import '../../../styles/calendar.css';

interface CalendarEvent {
  id: string;
  title: string;
  /** ISO date (YYYY-MM-DD) or datetime for the event start. */
  date: string;
  endDate?: string;
  /** LEAVE | HOLIDAY | ROSTER | SHIFT | other — unknown shapes are tolerated. */
  type?: string;
  employeeName?: string;
  /** Phase 3 item 1 (multi-entity): shown when the API provides it. */
  entityName?: string;
}

/**
 * Normalizes the GET /calendar response into CalendarEvent[].
 *
 * ASSUMPTION: the API contract for /calendar is not yet finalized by the
 * calendar API worker. We accept any of: a bare array, {items:[...]}, or
 * {events:[...]}, and read title from common keys. Fields we cannot read
 * are omitted rather than invented.
 */
function normalizeEvents(res: any): CalendarEvent[] {
  const raw: any[] = Array.isArray(res) ? res : res?.items || res?.events || [];
  return raw
    .map((e, i) => {
      const date: string =
        e.date || e.startDate || e.start || e.day || e.leaveDate || e.holidayDate || '';
      return {
        id: String(e.id ?? e._id ?? `evt-${i}`),
        title: String(e.title || e.name || e.reason || e.label || 'Event'),
        date: String(date),
        endDate: e.endDate || e.end || undefined,
        type: e.type || e.kind || e.eventType || undefined,
        employeeName:
          e.employeeName ||
          (e.employee ? `${e.employee.firstName || ''} ${e.employee.lastName || ''}`.trim() : undefined) ||
          undefined,
        // Multi-entity (Phase 3 item 1): rendered when the API ships entities.
        entityName: e.entityName || e.siteName || e.entity?.name || e.site?.name || undefined,
      };
    })
    .filter((e) => e.date);
}

function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month + 1)}-01`;
  const last = new Date(year, month + 1, 0).getDate();
  const to = `${year}-${pad(month + 1)}-${pad(last)}`;
  return { from, to };
}

const TYPE_COLORS: Record<string, string> = {
  LEAVE: '#f59e0b',
  HOLIDAY: '#10b981',
  ROSTER: '#6366f1',
  SHIFT: '#0ea5e9',
};

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const { from, to } = monthRange(cursor.year, cursor.month);
  const { data: rawEvents, isPending: loading, error: queryError, refetch } = useCalendarEventsQuery(from, to);
  const events = useMemo(() => normalizeEvents(rawEvents), [rawEvents]);
  const error = queryError ? (queryError as Error).message || 'Failed to load calendar events.' : null;

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const key = e.date.split('T')[0];
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const days = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first grid
    const cells: (string | null)[] = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    const last = new Date(cursor.year, cursor.month + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      cells.push(`${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return cells;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const todayKey = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  })();

  const dayEvents = selectedDay ? eventsByDay.get(selectedDay) || [] : [];

  return (
    <DashboardLayout title="Team Calendar">
      <div className="calendar-editorial-wrapper">
        <div className="cal-page">
          <header className="cal-header">
            <div>
              <h1 className="cal-title">Team Calendar</h1>
              <p className="cal-subtitle">
                Approved leaves, holidays, and roster events from {formatAppDate(new Date(from))} to{' '}
                {formatAppDate(new Date(to))}.
              </p>
            </div>
            <div className="cal-nav">
              <button
                onClick={() =>
                  setCursor((c) => ({ year: c.month === 0 ? c.year - 1 : c.year, month: (c.month + 11) % 12 }))
                }
                aria-label="Previous month"
                className="cal-nav-btn"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="cal-month-label">{monthLabel}</span>
              <button
                onClick={() =>
                  setCursor((c) => ({ year: c.month === 11 ? c.year + 1 : c.year, month: (c.month + 1) % 12 }))
                }
                aria-label="Next month"
                className="cal-nav-btn"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  const n = new Date();
                  setCursor({ year: n.getFullYear(), month: n.getMonth() });
                  setSelectedDay(null);
                }}
                className="cal-today-btn"
              >
                Today
              </button>
            </div>
          </header>

          {error && (
            <div style={{ marginBottom: '16px' }}>
              <ErrorBanner
                resource="calendar events"
                detail={error}
                onRetry={() => refetch()}
                retrying={loading}
              />
            </div>
          )}

          <div className="cal-layout">
            {/* Month grid */}
            <div className="cal-grid-card">
              {loading ? (
                <div className="cal-grid" aria-busy="true">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                    <div key={d} className="cal-weekday">
                      {d}
                    </div>
                  ))}
                  {Array.from({ length: 35 }).map((_, i) => (
                    <div key={i} className="cal-day" style={{ minHeight: '80px', opacity: 0.65 }}>
                      <Skeleton className="w-6 h-4 mb-2" />
                      {i % 3 === 0 && <Skeleton className="w-full h-3 mb-1" />}
                      {i % 4 === 0 && <Skeleton className="w-3/4 h-3" />}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="cal-grid">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                    <div key={d} className="cal-weekday">
                      {d}
                    </div>
                  ))}
                  {days.map((day, i) =>
                    day ? (
                      <button
                        key={day}
                        onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                        className={`cal-day ${day === todayKey ? 'cal-day-today' : ''} ${
                          selectedDay === day ? 'cal-day-selected' : ''
                        }`}
                        aria-label={`${day}, ${(eventsByDay.get(day) || []).length} events`}
                      >
                        <span className="cal-day-num">{Number(day.split('-')[2])}</span>
                        <div className="cal-day-events">
                          {(eventsByDay.get(day) || []).slice(0, 3).map((e) => (
                            <span
                              key={e.id}
                              className="cal-event-chip"
                              style={{
                                background: `${TYPE_COLORS[(e.type || '').toUpperCase()] || '#64748b'}22`,
                                borderLeft: `3px solid ${TYPE_COLORS[(e.type || '').toUpperCase()] || '#64748b'}`,
                              }}
                              title={e.title}
                            >
                              {e.title}
                            </span>
                          ))}
                          {(eventsByDay.get(day) || []).length > 3 && (
                            <span className="cal-more">+{(eventsByDay.get(day) || []).length - 3} more</span>
                          )}
                        </div>
                      </button>
                    ) : (
                      <div key={`empty-${i}`} className="cal-day-empty" />
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Agenda panel */}
            <div className="cal-agenda-card">
              <div className="cal-agenda-header">
                <CalendarDays className="w-4 h-4" />
                <span>{selectedDay ? `Events on ${formatAppDate(new Date(selectedDay))}` : 'Upcoming events'}</span>
              </div>
              <div className="cal-agenda-list">
                {selectedDay ? (
                  dayEvents.length === 0 ? (
                    <p className="cal-agenda-empty">No events on this day.</p>
                  ) : (
                    dayEvents.map((e) => (
                      <div key={e.id} className="cal-agenda-item">
                        <span
                          className="cal-agenda-dot"
                          style={{ background: TYPE_COLORS[(e.type || '').toUpperCase()] || '#64748b' }}
                        />
                        <div>
                          <div className="cal-agenda-title">{e.title}</div>
                          <div className="cal-agenda-meta">
                            {[e.type, e.employeeName, e.entityName].filter(Boolean).join(' • ')}
                          </div>
                        </div>
                      </div>
                    ))
                  )
                ) : events.length === 0 ? (
                  <p className="cal-agenda-empty">
                    {error ? 'Calendar data unavailable.' : 'No events this month.'}
                  </p>
                ) : (
                  [...events]
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .slice(0, 20)
                    .map((e) => (
                      <button
                        key={e.id}
                        onClick={() => setSelectedDay(e.date.split('T')[0])}
                        className="cal-agenda-item cal-agenda-btn"
                      >
                        <span className="cal-agenda-date">{formatAppDate(new Date(e.date))}</span>
                        <span
                          className="cal-agenda-dot"
                          style={{ background: TYPE_COLORS[(e.type || '').toUpperCase()] || '#64748b' }}
                        />
                        <div>
                          <div className="cal-agenda-title">{e.title}</div>
                          <div className="cal-agenda-meta">
                            {[e.type, e.employeeName, e.entityName].filter(Boolean).join(' • ')}
                          </div>
                        </div>
                      </button>
                    ))
                )}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="cal-legend">
            {Object.entries(TYPE_COLORS).map(([type, color]) => (
              <span key={type} className="cal-legend-item">
                <span className="cal-agenda-dot" style={{ background: color }} />
                {type.charAt(0) + type.slice(1).toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
