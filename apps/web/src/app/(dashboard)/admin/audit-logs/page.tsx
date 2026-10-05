'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  ShieldCheck,
  Search,
  Eye,
  Download,
  RefreshCw,
  User,
  Copy,
  Check,
  X,
  Fingerprint,
  Database,
  Layers
} from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api, Paginated } from '../../../../lib/api-client';
import { useAuth } from '../../../../context/auth-context';
import { useFocusTrap } from '../../../../hooks/use-focus-trap';
import { SystemRole } from '@ems/shared';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import { PaginationControls } from '../../../../components/ui/pagination';
import { Skeleton } from '../../../../components/ui/skeleton';
import '../../../../styles/audit.css';

interface AuditLog {
  id: string;
  actorEmail?: string;
  user?: { email: string; fullName?: string };
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  ipAddress?: string;
  userAgent?: string;
  hash?: string;
  beforeState?: Record<string, any> | null;
  afterState?: Record<string, any> | null;
}

const PAGE_SIZE = 20;

export default function AuditLogsPage() {
  const { hasRole } = useAuth();
  // Go-live §3.3: client-side role gate like the sibling admin pages
  // (users, roles). Mirrors the API's @Roles(SUPER_ADMIN, HR_ADMIN, AUDITOR)
  // on GET /audit so unauthorized users see an immediate, honest denial
  // instead of a permission-denied flash after the API 403s.
  const canView = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN, SystemRole.AUDITOR);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'MUTATION' | 'PAYROLL' | 'SECURITY' | 'AI'>('ALL');
  const [copiedState, setCopiedState] = useState(false);

  const auditModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(auditModalRef, { isActive: Boolean(selectedLog), onEscape: () => setSelectedLog(null) });

  const fetchLogs = useCallback(async (pageToLoad: number) => {
    setLoading(true);
    setError(null);
    try {
      // Audit trail lives at GET /audit (paginated, newest first).
      const res: Paginated<AuditLog> = await api.getPaginated<AuditLog>('/audit', {
        params: { page: pageToLoad, limit: PAGE_SIZE },
      });
      setLogs(res.items);
      setTotal(res.total);
      setPage(res.page);
    } catch (err: any) {
      // Never render fabricated audit events. Fail loudly.
      setError(err?.message || 'Failed to load audit logs.');
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Don't hit the API when the role gate denies the page — the server
    // would 403 anyway; show the denial state immediately instead.
    if (canView) fetchLogs(1);
  }, [fetchLogs, canView]);

  // Filtered and searched logs (client-side over the loaded page)
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (activeFilter === 'MUTATION') {
        if (!['CREATE', 'UPDATE', 'DELETE'].includes(log.action)) return false;
      } else if (activeFilter === 'PAYROLL') {
        if (!log.action.includes('PAYROLL') && log.entityType !== 'PAYROLL_RUN') return false;
      } else if (activeFilter === 'SECURITY') {
        if (!log.action.includes('AUTH') && !log.action.includes('ROLE') && log.entityType !== 'ACCESS_CONTROL') return false;
      } else if (activeFilter === 'AI') {
        if (!log.action.includes('AI') && log.entityType !== 'PAYROLL_ANOMALY') return false;
      }

      if (searchQuery.trim() === '') return true;
      const q = searchQuery.toLowerCase();
      const actor = (log.actorEmail || log.user?.email || '').toLowerCase();
      const action = (log.action || '').toLowerCase();
      const entityType = (log.entityType || '').toLowerCase();
      const entityId = (log.entityId || '').toLowerCase();
      const hash = (log.hash || '').toLowerCase();

      return (
        actor.includes(q) ||
        action.includes(q) ||
        entityType.includes(q) ||
        entityId.includes(q) ||
        hash.includes(q)
      );
    });
  }, [logs, activeFilter, searchQuery]);

  // Quick stats — computed from real API data only
  const totalEvents = total;
  const privilegedOperators = useMemo(() => {
    const set = new Set(logs.map((l) => l.actorEmail || l.user?.email || 'System'));
    return set.size;
  }, [logs]);
  const entityTypes = useMemo(() => {
    const set = new Set(logs.map((l) => l.entityType).filter(Boolean));
    return set.size;
  }, [logs]);

  const copySnapshotJson = () => {
    if (!selectedLog) return;
    navigator.clipboard.writeText(JSON.stringify(selectedLog, null, 2));
    setCopiedState(true);
    setTimeout(() => setCopiedState(false), 2000);
  };

  const exportAuditCsv = () => {
    const headers = ['ID', 'Timestamp', 'Actor', 'Action', 'EntityType', 'EntityID', 'Hash'];
    const rows = filteredLogs.map((l) => [
      l.id,
      l.createdAt,
      l.actorEmail || l.user?.email || 'System',
      l.action,
      l.entityType,
      l.entityId,
      l.hash || '',
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.map((val) => `"${val}"`).join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `neo_audit_trail_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getActionBadgeClass = (action: string) => {
    if (action === 'CREATE') return 'audit-badge-create';
    if (action.includes('PAYROLL') || action === 'UPDATE') return 'audit-badge-update';
    if (action.includes('AUTH') || action.includes('ROLE')) return 'audit-badge-auth';
    if (action.includes('AI')) return 'audit-badge-ai';
    if (action === 'DELETE') return 'audit-badge-delete';
    return 'audit-badge-default';
  };

  if (!canView) {
    return (
      <DashboardLayout title="System Compliance & Audit Trail">
        <div className="audit-page">
          <ErrorBanner
            resource="audit trail"
            detail="Your role does not include audit access (SUPER_ADMIN, HR_ADMIN, or AUDITOR)."
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="System Compliance & Audit Trail">
      <div className="audit-editorial-wrapper">
        <div className="audit-page">
          {/* Header */}
          <div className="audit-header">
            <div className="audit-header-top">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{
                    fontFamily: 'var(--audit-font-mono)',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--audit-accent)',
                    fontWeight: 600,
                    background: 'var(--audit-accent-light)',
                    padding: '2px 8px',
                    borderRadius: '4px'
                  }}>
                    Forensic Ledger &bull; Neoteric Digital
                  </span>
                </div>
                <h1 className="audit-title">System Compliance & Audit Trail</h1>
                <p className="audit-subtitle">
                  Audit ledger recording state mutations, authorization shifts, and privileged workforce operations.
                </p>
              </div>

              <div className="audit-header-actions">
                <button
                  onClick={exportAuditCsv}
                  className="audit-btn-primary"
                  title="Export current audit log as CSV"
                  disabled={filteredLogs.length === 0}
                >
                  <Download size={14} />
                  <span>Export CSV</span>
                </button>
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: '16px' }}>
                <ErrorBanner
                  resource="audit logs"
                  detail={error}
                  onRetry={() => fetchLogs(1)}
                  retrying={loading}
                />
              </div>
            )}

            {/* Quick stat cards — real data only */}
            <div className="audit-quick-stats">
              <div className="audit-quick-stat-card">
                <div className="audit-stat-header">
                  <span className="audit-stat-label">Logged Events</span>
                  <div className="audit-stat-icon-wrap">
                    <Database size={15} />
                  </div>
                </div>
                <div className="audit-stat-value">{error ? '—' : totalEvents}</div>
                <div className="audit-stat-caption">State transitions on record</div>
              </div>

              <div className="audit-quick-stat-card">
                <div className="audit-stat-header">
                  <span className="audit-stat-label">Privileged Actors</span>
                  <div className="audit-stat-icon-wrap">
                    <User size={15} />
                  </div>
                </div>
                <div className="audit-stat-value">{error ? '—' : privilegedOperators}</div>
                <div className="audit-stat-caption">Distinct actors in this view</div>
              </div>

              <div className="audit-quick-stat-card">
                <div className="audit-stat-header">
                  <span className="audit-stat-label">Entity Types</span>
                  <div className="audit-stat-icon-wrap">
                    <Layers size={15} />
                  </div>
                </div>
                <div className="audit-stat-value">{error ? '—' : entityTypes}</div>
                <div className="audit-stat-caption">Distinct entity types in this view</div>
              </div>

              <div className="audit-quick-stat-card">
                <div className="audit-stat-header">
                  <span className="audit-stat-label">Ledger Status</span>
                  <div className="audit-stat-icon-wrap">
                    <ShieldCheck size={15} />
                  </div>
                </div>
                <div className="audit-stat-value" style={{ color: error ? 'var(--audit-rose)' : 'var(--audit-accent)', fontSize: '16px' }}>
                  {error ? 'Unavailable' : loading ? 'Loading…' : 'Connected'}
                </div>
                <div className="audit-stat-caption">API-backed audit source</div>
              </div>
            </div>
          </div>

          {/* Controls Bar: Search & Category Filter Tabs */}
          <div className="audit-controls-card">
            <div className="audit-search-wrapper">
              <Search size={15} style={{ color: 'var(--audit-text-tertiary)' }} aria-hidden="true" />
              <input
                type="text"
                id="audit-search"
                aria-label="Search audit logs"
                placeholder="Search by actor, action (CREATE, PAYROLL), entity type, or hash..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="audit-search-input"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--audit-text-tertiary)', padding: 0 }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="audit-filter-tabs" role="tablist" aria-label="Audit event categories">
              <button
                className={`audit-filter-tab ${activeFilter === 'ALL' ? 'active' : ''}`}
                aria-pressed={activeFilter === 'ALL'}
                onClick={() => setActiveFilter('ALL')}
              >
                All Events ({total})
              </button>
              <button
                className={`audit-filter-tab ${activeFilter === 'MUTATION' ? 'active' : ''}`}
                aria-pressed={activeFilter === 'MUTATION'}
                onClick={() => setActiveFilter('MUTATION')}
              >
                Data Mutations
              </button>
              <button
                className={`audit-filter-tab ${activeFilter === 'PAYROLL' ? 'active' : ''}`}
                aria-pressed={activeFilter === 'PAYROLL'}
                onClick={() => setActiveFilter('PAYROLL')}
              >
                Payroll Operations
              </button>
              <button
                className={`audit-filter-tab ${activeFilter === 'SECURITY' ? 'active' : ''}`}
                aria-pressed={activeFilter === 'SECURITY'}
                onClick={() => setActiveFilter('SECURITY')}
              >
                Security & Auth
              </button>
              <button
                className={`audit-filter-tab ${activeFilter === 'AI' ? 'active' : ''}`}
                aria-pressed={activeFilter === 'AI'}
                onClick={() => setActiveFilter('AI')}
              >
                AI Inferences
              </button>
            </div>
          </div>

          {/* Table Card — polite live region: announced once per update */}
          <div className="audit-table-card" aria-live="polite" aria-label="Audit log entries">
            <table className="audit-table">
              <thead>
                <tr>
                  <th style={{ width: '160px' }}>Timestamp</th>
                  <th>Actor / Operator</th>
                  <th style={{ width: '130px' }}>Action</th>
                  <th>Entity Target</th>
                  <th>Entity Identifier</th>
                  <th>Forensic Checksum</th>
                  <th style={{ textAlign: 'right', width: '100px' }}>Inspection</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, r) => (
                    <tr key={r}>
                      {Array.from({ length: 7 }).map((_, c) => (
                        <td key={c} style={{ padding: '14px 16px' }}>
                          <Skeleton className="h-4" style={{ width: `${55 + ((r * 13 + c * 23) % 40)}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="audit-empty-state">
                        <ShieldCheck size={32} style={{ color: 'var(--audit-text-tertiary)', margin: '0 auto 12px' }} />
                        <h4 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--audit-text-primary)' }}>
                          {error ? 'Audit log unavailable' : 'No audit events match query'}
                        </h4>
                        <p style={{ fontSize: '13px', color: 'var(--audit-text-secondary)', marginTop: '4px' }}>
                          {error
                            ? 'The audit API could not be reached. Use Retry above — no placeholder data is shown.'
                            : 'Try adjusting search keywords or clearing active category filters.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => {
                    const actor = log.actorEmail || log.user?.email || 'system.internal';
                    return (
                      <tr key={log.id}>
                        <td>
                          <div style={{ fontFamily: 'var(--audit-font-mono)', fontSize: '11.5px', color: 'var(--audit-text-secondary)' }}>
                            {new Date(log.createdAt).toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: '2-digit'
                            })}
                          </div>
                          <div style={{ fontFamily: 'var(--audit-font-mono)', fontSize: '11px', color: 'var(--audit-text-tertiary)' }}>
                            {new Date(log.createdAt).toLocaleTimeString(undefined, {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                              hour12: false
                            })}
                          </div>
                        </td>

                        <td>
                          <div className="audit-actor-badge">
                            <div className="audit-actor-avatar">
                              {actor.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="audit-actor-email">{actor}</div>
                              {log.ipAddress && (
                                <div className="audit-actor-ip">{log.ipAddress}</div>
                              )}
                            </div>
                          </div>
                        </td>

                        <td>
                          <span className={`audit-action-badge ${getActionBadgeClass(log.action)}`}>
                            {log.action}
                          </span>
                        </td>

                        <td>
                          <span className="audit-entity-tag">
                            {log.entityType || 'CORE'}
                          </span>
                        </td>

                        <td>
                          <span className="audit-hash-mono">
                            {log.entityId || log.id.slice(0, 10)}
                          </span>
                        </td>

                        <td>
                          <span
                            className="audit-hash-mono"
                            title={log.hash || 'No checksum recorded'}
                            style={{ color: 'var(--audit-text-tertiary)' }}
                          >
                            {log.hash || '—'}
                          </span>
                        </td>

                        <td style={{ textAlign: 'right' }}>
                          <button
                            onClick={() => setSelectedLog(log)}
                            className="audit-inspect-btn"
                          >
                            <Eye size={13} />
                            <span>Inspect</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '16px' }}>
            <PaginationControls
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={(p) => fetchLogs(p)}
            />
          </div>

          {/* Footer note */}
          <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--audit-text-tertiary)', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Fingerprint size={12} style={{ color: 'var(--audit-accent)' }} />
              <span>Audit events are served by the API. Tamper-evidence verification is a server-side concern.</span>
            </div>
            <div>
              Displaying {filteredLogs.length} of {total} logged events (page {page})
            </div>
          </div>
        </div>

        {/* Diff Inspector Modal */}
        {selectedLog && (
          <div className="audit-modal-backdrop" onClick={() => setSelectedLog(null)}>
            <div
              ref={auditModalRef}
              className="audit-modal-dialog"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="audit-modal-title"
            >
              <div className="audit-modal-header">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`audit-action-badge ${getActionBadgeClass(selectedLog.action)}`}>
                      {selectedLog.action}
                    </span>
                    <span className="audit-entity-tag">{selectedLog.entityType}</span>
                    <span style={{ fontFamily: 'var(--audit-font-mono)', fontSize: '11.5px', color: 'var(--audit-text-tertiary)' }}>
                      #{selectedLog.entityId}
                    </span>
                  </div>
                  <h3 className="audit-modal-title" id="audit-modal-title" style={{ marginTop: '4px' }}>
                    Forensic Snapshot & State Transition
                  </h3>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    onClick={copySnapshotJson}
                    className="audit-copy-btn"
                    title="Copy snapshot JSON"
                  >
                    {copiedState ? <Check size={14} style={{ color: 'var(--audit-positive)' }} /> : <Copy size={14} />}
                    <span>{copiedState ? 'Copied' : 'Copy JSON'}</span>
                  </button>
                  <button
                    onClick={() => setSelectedLog(null)}
                    className="audit-modal-close"
                    aria-label="Close inspection"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Snapshot metadata card */}
              <div style={{
                background: 'var(--audit-bg)',
                border: '1px solid var(--audit-border)',
                borderRadius: 'var(--audit-radius-sm)',
                padding: '10px 14px',
                fontSize: '12px',
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '12px'
              }}>
                <div>
                  <div style={{ color: 'var(--audit-text-tertiary)', fontSize: '11px', textTransform: 'uppercase', fontFamily: 'var(--audit-font-mono)' }}>Actor</div>
                  <div style={{ fontWeight: 600, color: 'var(--audit-text-primary)' }}>
                    {selectedLog.actorEmail || selectedLog.user?.email || 'System'}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--audit-text-tertiary)', fontSize: '11px', textTransform: 'uppercase', fontFamily: 'var(--audit-font-mono)' }}>Timestamp</div>
                  <div style={{ fontFamily: 'var(--audit-font-mono)', color: 'var(--audit-text-primary)' }}>
                    {new Date(selectedLog.createdAt).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--audit-text-tertiary)', fontSize: '11px', textTransform: 'uppercase', fontFamily: 'var(--audit-font-mono)' }}>Checksum</div>
                  <div style={{ fontFamily: 'var(--audit-font-mono)', color: 'var(--audit-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedLog.hash || 'Not recorded'}
                  </div>
                </div>
              </div>

              {/* Before and After State Viewers */}
              <div className="audit-diff-grid">
                <div>
                  <div className="audit-diff-header">
                    <span className="audit-diff-title">Prior State (Before)</span>
                    <span style={{ fontSize: '11px', fontFamily: 'var(--audit-font-mono)', color: 'var(--audit-text-tertiary)' }}>
                      {selectedLog.beforeState ? 'RECORDED' : 'NULL / NEW'}
                    </span>
                  </div>
                  <pre className="audit-json-viewer before">
                    {JSON.stringify(selectedLog.beforeState || { status: 'NO_PREVIOUS_RECORD' }, null, 2)}
                  </pre>
                </div>

                <div>
                  <div className="audit-diff-header">
                    <span className="audit-diff-title" style={{ color: 'var(--audit-positive)' }}>
                      Mutated State (After)
                    </span>
                    <span style={{ fontSize: '11px', fontFamily: 'var(--audit-font-mono)', color: 'var(--audit-positive)' }}>
                      PERSISTED
                    </span>
                  </div>
                  <pre className="audit-json-viewer after">
                    {JSON.stringify(selectedLog.afterState || selectedLog, null, 2)}
                  </pre>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '6px' }}>
                <button
                  onClick={() => setSelectedLog(null)}
                  className="audit-btn-primary"
                >
                  Dismiss Inspection
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
