'use client';

import React, { useState, useEffect } from 'react';
import {
  Webhook,
  Calendar,
  FileSpreadsheet,
  MessageSquare,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Download,
  ExternalLink,
  Send,
  X,
  RefreshCw,
  Sliders,
  ShieldCheck,
  Code2,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/editorial-common.css';

interface PayrollRun {
  id: string;
  month: number;
  year: number;
  status: string;
  totalGross: number;
}

export default function IntegrationsPage() {
  const { user, hasRole } = useAuth();
  const canAdmin = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  // iCal State
  const [icalData, setIcalData] = useState<{ token: string; path: string } | null>(null);
  const [icalLoading, setIcalLoading] = useState(false);
  const [copiedIcal, setCopiedIcal] = useState(false);

  // Accounting State
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [accountingExporting, setAccountingExporting] = useState(false);

  // Webhook State
  const [alertForm, setAlertForm] = useState({
    title: 'Payroll Cycle Dispatched',
    message: 'Monthly payroll run has been disbursed and payslips are now available in the portal.',
    linkUrl: 'https://ems.internal/payroll',
  });
  const [alertSending, setAlertSending] = useState(false);
  const [alertResult, setAlertResult] = useState<{ slack?: any; teams?: any } | null>(null);

  // HRIS State
  const [hrisJson, setHrisJson] = useState(`[
  {
    "firstName": "Ada",
    "lastName": "Lovelace",
    "email": "ada.lovelace@ems.internal",
    "departmentCode": "ENG",
    "designationTitle": "Senior Systems Engineer",
    "phone": "+44 20 7946 0123"
  }
]`);
  const [hrisImporting, setHrisImporting] = useState(false);
  const [hrisResult, setHrisResult] = useState<{
    imported: number;
    updated: number;
    failed: number;
    errors: string[];
  } | null>(null);

  // Feedback states
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load iCal token and payroll runs
  useEffect(() => {
    setIcalLoading(true);
    api
      .get<{ token: string; path: string }>('/integrations/ical-token')
      .then((res) => {
        setIcalData(res);
      })
      .catch(() => {})
      .finally(() => setIcalLoading(false));

    if (canAdmin) {
      api
        .get<any>('/payroll/runs')
        .then((res) => {
          const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
          setPayrollRuns(list);
          if (list.length > 0) setSelectedRunId(list[0].id);
        })
        .catch(() => {});
    }
  }, [canAdmin]);

  const getFullIcalUrl = () => {
    if (!icalData) return '';
    if (typeof window === 'undefined') return icalData.path;
    return `${window.location.origin}/api/v1${icalData.path}`;
  };

  const handleCopyIcal = () => {
    const url = getFullIcalUrl();
    if (url) {
      navigator.clipboard.writeText(url);
      setCopiedIcal(true);
      setTimeout(() => setCopiedIcal(false), 3000);
    }
  };

  const handleDownloadIcs = async () => {
    if (!icalData?.token) return;
    try {
      await api.downloadFile(`/integrations/ical/${icalData.token}`, 'leave-calendar.ics');
      setActionSuccess('Downloaded leave-calendar.ics');
    } catch (err: any) {
      setError(err?.message || 'Failed to download iCal file.');
    }
  };

  const handleAccountingExport = async () => {
    if (!selectedRunId) return;
    try {
      setAccountingExporting(true);
      setError(null);
      await api.downloadFile(
        `/integrations/accounting/export?payrollRunId=${selectedRunId}`,
        `accounting-journal-${selectedRunId.slice(0, 8)}.csv`,
      );
      setActionSuccess('Double-entry accounting journal CSV downloaded successfully.');
    } catch (err: any) {
      setError(err?.message || 'Failed to export accounting journal.');
    } finally {
      setAccountingExporting(false);
    }
  };

  const handleSendAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setAlertSending(true);
      setError(null);
      const res = await api.post('/integrations/alert', {
        title: alertForm.title.trim(),
        message: alertForm.message.trim(),
        linkUrl: alertForm.linkUrl.trim() || undefined,
      });
      setAlertResult(res);
      setActionSuccess('Outbound integration alerts dispatched to configured webhook channels.');
    } catch (err: any) {
      setError(err?.message || 'Failed to dispatch webhook alert.');
    } finally {
      setAlertSending(false);
    }
  };

  const handleHrisImport = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setHrisImporting(true);
      setError(null);
      let parsed: any;
      try {
        parsed = JSON.parse(hrisJson);
      } catch (jsonErr: any) {
        throw new Error('Invalid JSON format: ' + jsonErr.message);
      }
      const employees = Array.isArray(parsed) ? parsed : [parsed];
      const res = await api.post('/integrations/hris/import', { employees });
      setHrisResult(res);
      setActionSuccess(`HRIS import completed: ${res.imported} inserted, ${res.updated} updated.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to execute HRIS batch import.');
    } finally {
      setHrisImporting(false);
    }
  };

  return (
    <DashboardLayout title="System Integrations & Webhooks">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">System Integrations & Webhooks</h1>
                <p className="editorial-subtitle">
                  External enterprise connectivity: live calendar feeds, ERP accounting exports, incident webhooks, and HRIS batch provisioning.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <Webhook size={14} style={{ color: 'var(--edit-accent)' }} />
                  <span>Integration Gateway:</span>
                  <span className="count">Operational</span>
                </div>
                <div className="editorial-stat-pill">
                  <span>Connectors:</span>
                  <span className="count">4 Active</span>
                </div>
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

          {/* Quick Metrics Grid */}
          <div className="editorial-quick-stats">
            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Calendar Subscription</div>
                <div className="editorial-quick-stat-value">iCal Feed</div>
                <div className="editorial-quick-stat-sub">Outlook & Google Calendar</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Calendar size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">General Ledger</div>
                <div className="editorial-quick-stat-value">ERP Sync</div>
                <div className="editorial-quick-stat-sub">Xero & QuickBooks journals</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <FileSpreadsheet size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Enterprise Broadcast</div>
                <div className="editorial-quick-stat-value">Webhooks</div>
                <div className="editorial-quick-stat-sub">Slack & Microsoft Teams</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <MessageSquare size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Personnel Importer</div>
                <div className="editorial-quick-stat-value">HRIS API</div>
                <div className="editorial-quick-stat-sub">Batch JSON payload ingest</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <UploadCloud size={18} />
              </div>
            </div>
          </div>

          {/* Integrations Grid (2x2 Editorial Cards) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: '24px' }}>
            {/* Card 1: iCal Calendar Feed */}
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
                gap: '18px',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
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
                      <Calendar size={18} />
                    </div>
                    <div>
                      <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                        Live Leave & Schedule iCal Feed
                      </h3>
                      <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                        RFC 5545 iCalendar Internet Standard
                      </div>
                    </div>
                  </div>
                  <span className="editorial-badge editorial-badge-positive">Active Token</span>
                </div>

                <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', marginTop: '14px', lineHeight: 1.5 }}>
                  Subscribe to your personal approved leave dates and shift schedules directly in Apple Calendar, Microsoft Outlook, or Google Calendar using a secure feed token.
                </p>

                {/* Feed URL Field */}
                <div style={{ marginTop: '14px' }}>
                  <label className="editorial-label">Your Private iCal Subscription URL</label>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <input
                      readOnly
                      type="text"
                      value={getFullIcalUrl() || 'Generating secure feed token...'}
                      className="editorial-input editorial-mono"
                      style={{ fontSize: '11.5px', background: 'var(--edit-surface-muted)' }}
                    />
                    <button
                      onClick={handleCopyIcal}
                      disabled={!icalData}
                      className="editorial-btn-secondary"
                      style={{ flexShrink: 0 }}
                    >
                      {copiedIcal ? <Check size={14} style={{ color: 'var(--edit-positive)' }} /> : <Copy size={14} />}
                      <span>{copiedIcal ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '14px', borderTop: '1px solid var(--edit-border-subtle)' }}>
                <span style={{ fontSize: '12px', color: 'var(--edit-text-tertiary)' }}>
                  Feed refreshes every 60 minutes
                </span>
                <button
                  onClick={handleDownloadIcs}
                  disabled={!icalData}
                  className="editorial-btn-ghost"
                  style={{ color: 'var(--edit-accent)', fontWeight: 600 }}
                >
                  <Download size={13} />
                  <span>Download .ics File</span>
                </button>
              </div>
            </div>

            {/* Card 2: ERP General Ledger Export */}
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
                gap: '18px',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: 'var(--edit-radius-sm)',
                        background: 'var(--edit-info-bg)',
                        color: 'var(--edit-info)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <FileSpreadsheet size={18} />
                    </div>
                    <div>
                      <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                        Accounting & General Ledger Sync
                      </h3>
                      <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                        Double-Entry Journal Balancing
                      </div>
                    </div>
                  </div>
                  <span className="editorial-badge editorial-badge-info">Xero / QuickBooks</span>
                </div>

                <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', marginTop: '14px', lineHeight: 1.5 }}>
                  Generate balanced accounting journal entries (Wages Expense Debit, Net Pay Clearing & PAYE/NI Liability Credits) for import into your finance ERP software.
                </p>

                {canAdmin ? (
                  <div style={{ marginTop: '14px' }}>
                    <label className="editorial-label">Select Finalized Payroll Cycle</label>
                    <select
                      value={selectedRunId}
                      onChange={(e) => setSelectedRunId(e.target.value)}
                      className="editorial-select"
                      style={{ marginTop: '4px' }}
                    >
                      {payrollRuns.map((r) => (
                        <option key={r.id} value={r.id}>
                          Period {r.year}-{String(r.month).padStart(2, '0')} ({r.status}) — Gross £
                          {Number(r.totalGross).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div style={{ padding: '12px', background: 'var(--edit-surface-muted)', borderRadius: 'var(--edit-radius-md)', fontSize: '12px', color: 'var(--edit-text-tertiary)' }}>
                    Requires HR Administrator or Finance role to export general ledger records.
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '14px', borderTop: '1px solid var(--edit-border-subtle)' }}>
                <span style={{ fontSize: '12px', color: 'var(--edit-text-tertiary)' }}>
                  Format: Standard CSV Journal
                </span>
                {canAdmin && (
                  <button
                    onClick={handleAccountingExport}
                    disabled={accountingExporting || !selectedRunId}
                    className="editorial-btn-primary"
                  >
                    <Download size={14} />
                    <span>{accountingExporting ? 'Exporting...' : 'Export Journal CSV'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Card 3: Outbound Broadcast Webhook Alerts */}
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: 'var(--edit-radius-sm)',
                      background: 'var(--edit-purple-bg)',
                      color: 'var(--edit-purple)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <MessageSquare size={18} />
                  </div>
                  <div>
                    <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                      Broadcast Notification Webhooks
                    </h3>
                    <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                      Slack & Microsoft Teams Gateway
                    </div>
                  </div>
                </div>
                <span className="editorial-badge editorial-badge-purple">Outbound HTTPS</span>
              </div>

              <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                Transmit urgent workforce broadcast notifications, company-wide alerts, or critical system announcements to team channels.
              </p>

              <form onSubmit={handleSendAlert} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="editorial-form-group">
                  <label className="editorial-label">Alert Headline *</label>
                  <input
                    required
                    type="text"
                    value={alertForm.title}
                    onChange={(e) => setAlertForm({ ...alertForm, title: e.target.value })}
                    className="editorial-input"
                  />
                </div>

                <div className="editorial-form-group">
                  <label className="editorial-label">Message Payload *</label>
                  <textarea
                    required
                    rows={2}
                    value={alertForm.message}
                    onChange={(e) => setAlertForm({ ...alertForm, message: e.target.value })}
                    className="editorial-textarea"
                  />
                </div>

                <div className="editorial-form-group">
                  <label className="editorial-label">Call-to-Action Link (Optional)</label>
                  <input
                    type="url"
                    value={alertForm.linkUrl}
                    onChange={(e) => setAlertForm({ ...alertForm, linkUrl: e.target.value })}
                    className="editorial-input editorial-mono"
                    style={{ fontSize: '12px' }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={alertSending}
                  className="editorial-btn-primary"
                  style={{ justifyContent: 'center' }}
                >
                  <Send size={14} />
                  <span>{alertSending ? 'Dispatching...' : 'Dispatch Webhook Alert'}</span>
                </button>
              </form>

              {alertResult && (
                <div style={{ marginTop: '8px' }}>
                  <label className="editorial-label">Dispatcher Response Receipt</label>
                  <pre className="editorial-code-box" style={{ fontSize: '11px', maxHeight: '120px' }}>
                    {JSON.stringify(alertResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Card 4: HRIS Batch Ingest */}
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: 'var(--edit-radius-sm)',
                      background: 'var(--edit-warning-bg)',
                      color: 'var(--edit-warning)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <UploadCloud size={18} />
                  </div>
                  <div>
                    <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                      HRIS Batch Personnel Provisioning
                    </h3>
                    <div style={{ fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                      JSON Batch Import Engine
                    </div>
                  </div>
                </div>
                <span className="editorial-badge editorial-badge-warning">Upsert Mode</span>
              </div>

              <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', margin: 0, lineHeight: 1.5 }}>
                Bulk import new staff, upsert email records, and link departmental designations from external identity providers or Workday/HiBob exports.
              </p>

              <form onSubmit={handleHrisImport} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="editorial-form-group">
                  <label className="editorial-label">JSON Personnel Array Payload *</label>
                  <textarea
                    required
                    rows={6}
                    value={hrisJson}
                    onChange={(e) => setHrisJson(e.target.value)}
                    className="editorial-textarea editorial-mono"
                    style={{ fontSize: '11.5px', background: '#1c1b18', color: '#e8e6df' }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={hrisImporting || !canAdmin}
                  className="editorial-btn-primary"
                  style={{ justifyContent: 'center' }}
                >
                  <UploadCloud size={14} />
                  <span>{hrisImporting ? 'Ingesting Data...' : 'Execute HRIS Ingest'}</span>
                </button>
              </form>

              {hrisResult && (
                <div
                  style={{
                    padding: '12px',
                    borderRadius: 'var(--edit-radius-md)',
                    background: hrisResult.failed > 0 ? 'var(--edit-warning-bg)' : 'var(--edit-positive-bg)',
                    border: '1px solid var(--edit-border)',
                    fontSize: '12px',
                    color: 'var(--edit-text-primary)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>Import Summary:</div>
                  <div className="editorial-mono" style={{ marginTop: '4px' }}>
                    Imported: {hrisResult.imported} | Updated: {hrisResult.updated} | Failed: {hrisResult.failed}
                  </div>
                  {hrisResult.errors && hrisResult.errors.length > 0 && (
                    <div style={{ marginTop: '6px', color: 'var(--edit-rose)', fontSize: '11px' }}>
                      Errors: {hrisResult.errors.join('; ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
