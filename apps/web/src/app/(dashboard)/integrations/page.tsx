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
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/admin.css';

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
    // 1. Fetch iCal feed token
    setIcalLoading(true);
    api
      .get<{ token: string; path: string }>('/integrations/ical-token')
      .then((res) => {
        setIcalData(res);
      })
      .catch((err) => {
        // Non-blocking if secret is not set in sandbox
      })
      .finally(() => setIcalLoading(false));

    // 2. Fetch payroll runs for accounting export
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
        `accounting-journal-${selectedRunId.slice(0, 8)}.csv`
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
      setActionSuccess('Webhook notification dispatched to Slack and Microsoft Teams.');
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
      let parsed = [];
      try {
        parsed = JSON.parse(hrisJson);
      } catch {
        throw new Error('Invalid JSON format. Please verify your employee array syntax.');
      }

      if (!Array.isArray(parsed)) {
        throw new Error('HRIS payload must be a JSON array of employee objects.');
      }

      const res = await api.post('/integrations/hris/import', { employees: parsed });
      setHrisResult(res);
      setActionSuccess(`HRIS sync complete: ${res.imported} imported, ${res.updated} updated.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to run HRIS import.');
    } finally {
      setHrisImporting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Header */}
        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-teal-50 text-teal-700">
                <Webhook size={22} />
              </span>
              <h1 className="adm-title">System Integrations & Webhooks</h1>
            </div>
            <p className="adm-subtitle">
              Calendar subscription feeds, general ledger accounting exports, operational chat webhooks, and external HRIS roster sync.
            </p>
          </div>
        </div>

        {/* Feedback Alerts */}
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

        {/* 2x2 Grid of Integrations */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Card 1: Personal Leave Calendar iCal Feed */}
          <div className="adm-card flex flex-col justify-between gap-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-blue-50 text-blue-700">
                    <Calendar size={18} />
                  </span>
                  <h2 className="text-base font-bold text-gray-900">Personal Leave Calendar Feed</h2>
                </div>
                <span className="text-[11px] font-bold bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full">
                  iCal / RFC 5545
                </span>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed mb-4">
                Subscribe to your personal approved leave, scheduled holidays, and company non-working days directly in
                Google Calendar, Apple Calendar, or Microsoft Outlook. The feed is cryptographically authenticated via
                HMAC SHA-256.
              </p>

              {icalLoading ? (
                <div className="adm-empty">Generating personal feed token...</div>
              ) : icalData ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="adm-label">Subscription Feed URL</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={getFullIcalUrl()}
                        className="adm-input text-xs font-mono bg-gray-50 text-gray-700"
                      />
                      <button
                        type="button"
                        onClick={handleCopyIcal}
                        className="adm-btn adm-btn-ghost adm-btn-sm whitespace-nowrap"
                      >
                        {copiedIcal ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                        <span>{copiedIcal ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-600 flex flex-col gap-1">
                    <span className="font-semibold text-gray-800">Supported Calendar Clients:</span>
                    <span>• Apple Calendar: File → New Calendar Subscription → Paste URL</span>
                    <span>• Google Calendar: Other calendars (+) → From URL → Paste URL</span>
                    <span>• Microsoft Outlook: Add calendar → Subscribe from web</span>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-amber-50 border border-amber-200 text-amber-900 rounded-xl text-xs">
                  Calendar feed secret is not configured in this environment.
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-gray-100 flex items-center justify-end">
              <button
                type="button"
                disabled={!icalData}
                onClick={handleDownloadIcs}
                className="adm-btn adm-btn-ghost adm-btn-sm text-xs"
              >
                <Download size={13} />
                <span>Download .ics File</span>
              </button>
            </div>
          </div>

          {/* Card 2: Accounting System Journal Export */}
          <div className="adm-card flex flex-col justify-between gap-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-emerald-50 text-emerald-700">
                    <FileSpreadsheet size={18} />
                  </span>
                  <h2 className="text-base font-bold text-gray-900">General Ledger Accounting Export</h2>
                </div>
                <span className="text-[11px] font-bold bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full">
                  Double-Entry CSV
                </span>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed mb-4">
                Export double-entry journal vouchers formatted for ERPs (SAP, NetSuite, Xero, QuickBooks, Sage).
                Generates balanced DR Wages Expense, CR Deductions Payable, and CR Net Pay Payable lines per payslip.
              </p>

              {canAdmin ? (
                <div className="flex flex-col gap-3">
                  <div className="adm-form-group">
                    <label className="adm-label">Select Payroll Run</label>
                    <select
                      value={selectedRunId}
                      onChange={(e) => setSelectedRunId(e.target.value)}
                      className="adm-select text-xs"
                    >
                      {payrollRuns.length === 0 ? (
                        <option value="">No payroll runs found</option>
                      ) : (
                        payrollRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            Period {r.year}-{String(r.month).padStart(2, '0')} ({r.status}) — Gross: £
                            {Number(r.totalGross || 0).toLocaleString()}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-xs text-gray-600 flex flex-col gap-1">
                    <span className="font-semibold text-gray-800">Chart of Accounts Mapping:</span>
                    <span>• 6000: Wages & Salaries Expense (DR)</span>
                    <span>• 2100: Payroll Deductions & Taxes Payable (CR)</span>
                    <span>• 2200: Net Wages & Disbursements Payable (CR)</span>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-gray-50 border border-gray-200 text-gray-600 rounded-xl text-xs">
                  Administrative privilege required to export accounting journals.
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-gray-100 flex items-center justify-end">
              <button
                type="button"
                disabled={!selectedRunId || accountingExporting || !canAdmin}
                onClick={handleAccountingExport}
                className="adm-btn adm-btn-primary adm-btn-sm text-xs"
              >
                <Download size={13} />
                <span>{accountingExporting ? 'Exporting...' : 'Export Journal CSV'}</span>
              </button>
            </div>
          </div>

          {/* Card 3: Slack & Microsoft Teams Webhooks */}
          <div className="adm-card flex flex-col justify-between gap-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-purple-50 text-purple-700">
                    <MessageSquare size={18} />
                  </span>
                  <h2 className="text-base font-bold text-gray-900">Slack & Teams Alert Dispatcher</h2>
                </div>
                <span className="text-[11px] font-bold bg-purple-100 text-purple-800 px-2.5 py-0.5 rounded-full">
                  Incoming Webhooks
                </span>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed mb-4">
                Dispatch structured event alerts to corporate Slack channels and Microsoft Teams connectors.
                Used for critical payroll disbursal, shift roster notices, and emergency announcements.
              </p>

              {canAdmin ? (
                <form onSubmit={handleSendAlert} className="flex flex-col gap-3">
                  <div className="adm-form-group">
                    <label className="adm-label">Alert Title *</label>
                    <input
                      type="text"
                      required
                      value={alertForm.title}
                      onChange={(e) => setAlertForm({ ...alertForm, title: e.target.value })}
                      className="adm-input text-xs"
                    />
                  </div>

                  <div className="adm-form-group">
                    <label className="adm-label">Message Content *</label>
                    <textarea
                      rows={2}
                      required
                      value={alertForm.message}
                      onChange={(e) => setAlertForm({ ...alertForm, message: e.target.value })}
                      className="adm-input text-xs"
                    />
                  </div>

                  <div className="adm-form-group">
                    <label className="adm-label">Link Action URL (Optional)</label>
                    <input
                      type="url"
                      value={alertForm.linkUrl}
                      onChange={(e) => setAlertForm({ ...alertForm, linkUrl: e.target.value })}
                      className="adm-input text-xs"
                    />
                  </div>

                  {alertResult && (
                    <div className="p-3 bg-purple-50 rounded-xl border border-purple-200 text-xs text-purple-900">
                      <div>Slack: {alertResult.slack?.delivered ? '✅ Delivered' : '⚠️ No webhook configured'}</div>
                      <div>Teams: {alertResult.teams?.delivered ? '✅ Delivered' : '⚠️ No webhook configured'}</div>
                    </div>
                  )}

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={alertSending}
                      className="adm-btn adm-btn-primary adm-btn-sm text-xs"
                    >
                      <Send size={13} />
                      <span>{alertSending ? 'Sending...' : 'Broadcast Alert'}</span>
                    </button>
                  </div>
                </form>
              ) : (
                <div className="p-3 bg-gray-50 border border-gray-200 text-gray-600 rounded-xl text-xs">
                  Administrative privilege required to trigger webhook dispatches.
                </div>
              )}
            </div>
          </div>

          {/* Card 4: External HRIS Bulk Sync */}
          <div className="adm-card flex flex-col justify-between gap-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-amber-50 text-amber-700">
                    <UploadCloud size={18} />
                  </span>
                  <h2 className="text-base font-bold text-gray-900">External HRIS Bulk Sync</h2>
                </div>
                <span className="text-[11px] font-bold bg-amber-100 text-amber-800 px-2.5 py-0.5 rounded-full">
                  Roster Import
                </span>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed mb-4">
                Synchronise employee records from external upstream HRIS systems (Workday, BambooHR, Personio).
                Upserts matching employee profiles, links department codes, and creates missing accounts.
              </p>

              {canAdmin ? (
                <form onSubmit={handleHrisImport} className="flex flex-col gap-3">
                  <div className="adm-form-group">
                    <label className="adm-label">HRIS Employee JSON Payload</label>
                    <textarea
                      rows={6}
                      required
                      value={hrisJson}
                      onChange={(e) => setHrisJson(e.target.value)}
                      className="adm-input text-xs font-mono"
                    />
                  </div>

                  {hrisResult && (
                    <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-xs text-emerald-900">
                      <div className="font-semibold">Sync Results:</div>
                      <div>• Imported New: {hrisResult.imported}</div>
                      <div>• Updated Existing: {hrisResult.updated}</div>
                      <div>• Failed: {hrisResult.failed}</div>
                      {hrisResult.errors?.length > 0 && (
                        <div className="mt-1 text-rose-700">Errors: {hrisResult.errors.join(', ')}</div>
                      )}
                    </div>
                  )}

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={hrisImporting}
                      className="adm-btn adm-btn-primary adm-btn-sm text-xs"
                    >
                      <UploadCloud size={13} />
                      <span>{hrisImporting ? 'Syncing...' : 'Run HRIS Import'}</span>
                    </button>
                  </div>
                </form>
              ) : (
                <div className="p-3 bg-gray-50 border border-gray-200 text-gray-600 rounded-xl text-xs">
                  Administrative privilege required to execute bulk HRIS imports.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
