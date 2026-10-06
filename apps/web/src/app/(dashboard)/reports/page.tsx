'use client';

import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  FileSpreadsheet,
  FileText,
  Download,
  Calendar,
  Building2,
  Users,
  UserX,
  Clock,
  Banknote,
  Database,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  Play,
  Table,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/admin.css';

interface Department {
  id: string;
  name: string;
  code: string;
}

interface ReportConfig {
  type: 'headcount' | 'turnover' | 'absence' | 'overtime' | 'payroll-cost';
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tag: string;
  color: string;
  bg: string;
}

const STANDARD_REPORTS: ReportConfig[] = [
  {
    type: 'headcount',
    title: 'Headcount & Workforce Demographics',
    subtitle: 'Point-in-time active personnel census categorized by department and job designation.',
    icon: Users,
    tag: 'Core Census',
    color: '#2563eb',
    bg: '#eff6ff',
  },
  {
    type: 'turnover',
    title: 'Turnover & Leavers Analysis',
    subtitle: 'Point-in-time leaver metrics, attrition trends, and employment separation statistics.',
    icon: UserX,
    tag: 'Retention',
    color: '#dc2626',
    bg: '#fef2f2',
  },
  {
    type: 'absence',
    title: 'Absence & Attendance Lost Time',
    subtitle: 'Unplanned absence records, leave status frequencies, and operational time deficits.',
    icon: Clock,
    tag: 'Operations',
    color: '#d97706',
    bg: '#fffbeb',
  },
  {
    type: 'overtime',
    title: 'Overtime & Extended Hours',
    subtitle: 'Cumulative hours worked beyond the standard 8-hour shift schedule.',
    icon: BarChart3,
    tag: 'Productivity',
    color: '#7c3aed',
    bg: '#f5f3ff',
  },
  {
    type: 'payroll-cost',
    title: 'Payroll Expenditure & Statutory Costs',
    subtitle: 'Comprehensive gross remuneration, employer NI/statutory contributions, and net payouts.',
    icon: Banknote,
    tag: 'Finance',
    color: '#059669',
    bg: '#ecfdf5',
  },
];

export default function ReportsPage() {
  const { hasRole } = useAuth();
  const [activeTab, setActiveTab] = useState<'standard' | 'adhoc' | 'warehouse'>('standard');

  // Filter States
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDept, setSelectedDept] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState<string>(() => new Date().toISOString().split('T')[0]);

  // Loading & Feedback
  const [downloadingType, setDownloadingType] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ad-hoc Query State
  const [adhocEntity, setAdhocEntity] = useState<'employees' | 'leaves' | 'attendance' | 'payroll'>('employees');
  const [adhocLimit, setAdhocLimit] = useState<number>(50);
  const [adhocRunning, setAdhocRunning] = useState(false);
  const [adhocResults, setAdhocResults] = useState<any[] | null>(null);

  // Warehouse State
  const [warehouseDownloading, setWarehouseDownloading] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Department[]>('/departments')
      .then((res) => {
        if (Array.isArray(res)) setDepartments(res);
      })
      .catch(() => {});
  }, []);

  const handleDownloadStandard = async (
    type: ReportConfig['type'],
    format: 'csv' | 'xlsx' | 'pdf'
  ) => {
    try {
      setDownloadingType(`${type}-${format}`);
      setError(null);

      const params = new URLSearchParams();
      params.append('format', format);
      if (fromDate) params.append('from', fromDate);
      if (toDate) params.append('to', toDate);
      if (selectedDept) params.append('departmentId', selectedDept);

      const filename = `${type}-report-${new Date().toISOString().split('T')[0]}.${format}`;
      await api.downloadFile(`/reports/${type}?${params.toString()}`, filename);

      setActionSuccess(`Successfully generated and downloaded ${filename}`);
    } catch (err: any) {
      setError(err?.message || `Failed to download ${type} report.`);
    } finally {
      setDownloadingType(null);
    }
  };

  const handleRunAdHoc = async () => {
    try {
      setAdhocRunning(true);
      setError(null);
      const res = await api.post<any[]>('/reports/adhoc', {
        entity: adhocEntity,
        limit: Number(adhocLimit),
      });
      const data = Array.isArray(res) ? res : (res as any)?.items || [];
      setAdhocResults(data);
      setActionSuccess(`Retrieved ${data.length} records from ${adhocEntity} dataset.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to execute ad-hoc query.');
    } finally {
      setAdhocRunning(false);
    }
  };

  const handleWarehouseExport = async (entity: string) => {
    try {
      setWarehouseDownloading(entity);
      setError(null);
      const res = await api.get(`/reports/warehouse/${entity}`);
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `warehouse-${entity}-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setActionSuccess(`Exported ${entity} data warehouse feed.`);
    } catch (err: any) {
      setError(err?.message || `Failed to export warehouse feed for ${entity}.`);
    } finally {
      setWarehouseDownloading(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Header */}
        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-blue-50 text-blue-700">
                <BarChart3 size={22} />
              </span>
              <h1 className="adm-title">Reports & Business Intelligence</h1>
            </div>
            <p className="adm-subtitle">
              Generate operational workforce summaries, export formatted audit documents, or execute ad-hoc queries.
            </p>
          </div>

          {/* Tab Navigation */}
          <div className="flex items-center gap-1 bg-gray-100 p-1 rounded-xl text-xs font-semibold text-gray-600">
            <button
              onClick={() => setActiveTab('standard')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'standard' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
              }`}
            >
              Standard Reports
            </button>
            <button
              onClick={() => setActiveTab('adhoc')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'adhoc' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
              }`}
            >
              Ad-Hoc Explorer
            </button>
            {hasRole(SystemRole.SUPER_ADMIN, SystemRole.AUDITOR) && (
              <button
                onClick={() => setActiveTab('warehouse')}
                className={`px-3 py-1.5 rounded-lg transition-all ${
                  activeTab === 'warehouse' ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
                }`}
              >
                Data Warehouse
              </button>
            )}
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

        {/* TAB 1: STANDARD EXECUTIVE REPORTS */}
        {activeTab === 'standard' && (
          <div className="flex flex-col gap-6">
            {/* Filter Bar */}
            <div className="adm-card flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                <div className="flex items-center gap-2">
                  <Calendar size={15} className="text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">Period:</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="adm-input py-1.5 text-xs w-36"
                  />
                  <span className="text-xs text-gray-400">to</span>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="adm-input py-1.5 text-xs w-36"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 w-full md:w-auto">
                <Building2 size={15} className="text-gray-400" />
                <select
                  value={selectedDept}
                  onChange={(e) => setSelectedDept(e.target.value)}
                  className="adm-select py-1.5 text-xs md:w-56"
                >
                  <option value="">All Departments</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Report Grid Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {STANDARD_REPORTS.map((report) => {
                const Icon = report.icon;
                const isDownloadingCsv = downloadingType === `${report.type}-csv`;
                const isDownloadingXlsx = downloadingType === `${report.type}-xlsx`;
                const isDownloadingPdf = downloadingType === `${report.type}-pdf`;

                return (
                  <div
                    key={report.type}
                    className="adm-card flex flex-col justify-between gap-4 hover:shadow-md transition-shadow"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div
                          className="p-2.5 rounded-xl"
                          style={{ backgroundColor: report.bg, color: report.color }}
                        >
                          <Icon size={20} />
                        </div>
                        <span
                          className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                          style={{ backgroundColor: report.bg, color: report.color }}
                        >
                          {report.tag}
                        </span>
                      </div>

                      <h2 className="text-base font-bold text-gray-900 mb-1">{report.title}</h2>
                      <p className="text-xs text-gray-500 leading-relaxed">{report.subtitle}</p>
                    </div>

                    <div className="pt-3 border-t border-gray-100 flex flex-col gap-2">
                      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                        Download Report Format
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          disabled={Boolean(downloadingType)}
                          onClick={() => handleDownloadStandard(report.type, 'csv')}
                          className="adm-btn adm-btn-ghost adm-btn-sm justify-center text-xs font-semibold"
                        >
                          <FileText size={12} />
                          <span>{isDownloadingCsv ? '...' : 'CSV'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={Boolean(downloadingType)}
                          onClick={() => handleDownloadStandard(report.type, 'xlsx')}
                          className="adm-btn adm-btn-ghost adm-btn-sm justify-center text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          <FileSpreadsheet size={12} />
                          <span>{isDownloadingXlsx ? '...' : 'Excel'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={Boolean(downloadingType)}
                          onClick={() => handleDownloadStandard(report.type, 'pdf')}
                          className="adm-btn adm-btn-ghost adm-btn-sm justify-center text-xs font-semibold text-rose-700 hover:bg-rose-50"
                        >
                          <Download size={12} />
                          <span>{isDownloadingPdf ? '...' : 'PDF'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 2: AD-HOC QUERY EXPLORER */}
        {activeTab === 'adhoc' && (
          <div className="flex flex-col gap-5">
            <div className="adm-card flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">Dataset Entity:</span>
                </div>
                <select
                  value={adhocEntity}
                  onChange={(e) => setAdhocEntity(e.target.value as any)}
                  className="adm-select py-1.5 text-xs w-44"
                >
                  <option value="employees">Employees Roster</option>
                  <option value="leaves">Leave Applications</option>
                  <option value="attendance">Attendance Records</option>
                  <option value="payroll">Payroll Runs</option>
                </select>

                <span className="text-xs font-semibold text-gray-700 ml-2">Row Limit:</span>
                <select
                  value={adhocLimit}
                  onChange={(e) => setAdhocLimit(Number(e.target.value))}
                  className="adm-select py-1.5 text-xs w-24"
                >
                  <option value={25}>25 rows</option>
                  <option value={50}>50 rows</option>
                  <option value={100}>100 rows</option>
                  <option value={250}>250 rows</option>
                </select>
              </div>

              <button
                type="button"
                disabled={adhocRunning}
                onClick={handleRunAdHoc}
                className="adm-btn adm-btn-primary adm-btn-sm"
              >
                <Play size={13} fill="currentColor" />
                <span>{adhocRunning ? 'Executing...' : 'Run Query'}</span>
              </button>
            </div>

            {/* Ad-Hoc Results Table */}
            <div className="adm-card flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                  <Table size={15} />
                  <span>Query Results {adhocResults ? `(${adhocResults.length} records)` : ''}</span>
                </h2>
              </div>

              {!adhocResults ? (
                <div className="adm-empty py-12">
                  <Database size={32} className="mx-auto text-gray-300 mb-2" />
                  <p>Select an entity dataset above and click "Run Query" to preview records in real time.</p>
                </div>
              ) : adhocResults.length === 0 ? (
                <div className="adm-empty">No records found matching the query.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="adm-table">
                    <thead>
                      <tr>
                        {Object.keys(adhocResults[0] || {}).map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {adhocResults.map((row, idx) => (
                        <tr key={idx}>
                          {Object.keys(row).map((col) => {
                            const val = row[col];
                            let rendered = '';
                            if (val === null || val === undefined) rendered = '—';
                            else if (typeof val === 'object') rendered = JSON.stringify(val);
                            else rendered = String(val);

                            return (
                              <td key={col} className="max-w-xs truncate text-xs font-mono">
                                {rendered}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: DATA WAREHOUSE & BI INTEGRATION */}
        {activeTab === 'warehouse' && (
          <div className="flex flex-col gap-5">
            <div className="adm-card">
              <h2 className="text-base font-bold text-gray-900 mb-1">External Data Warehouse & BI Feeds</h2>
              <p className="text-xs text-gray-500 mb-4">
                Structured JSON endpoints optimized for ETL/ELT pipelines, Snowflake, BigQuery, or PowerBI ingestion.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { id: 'employees', label: 'Employees Schema Feed', desc: 'Roster, department linkages, employment status' },
                  { id: 'leaves', label: 'Leaves Schema Feed', desc: 'All leave requests, approval flows, day counts' },
                  { id: 'attendance', label: 'Attendance Feed', desc: 'Biometric punches, shift schedules, late arrivals' },
                  { id: 'payroll', label: 'Payroll & Cost Feed', desc: 'Historic payroll runs, earnings, and deductions' },
                  { id: 'audit', label: 'Audit Trail Feed', desc: 'Immutable compliance actions, IP logs, and mutations' },
                ].map((feed) => (
                  <div key={feed.id} className="p-4 rounded-xl border border-gray-200 bg-gray-50/50 flex flex-col justify-between gap-3">
                    <div>
                      <div className="font-semibold text-sm text-gray-900">{feed.label}</div>
                      <p className="text-xs text-gray-500 mt-1">{feed.desc}</p>
                    </div>

                    <button
                      type="button"
                      disabled={warehouseDownloading === feed.id}
                      onClick={() => handleWarehouseExport(feed.id)}
                      className="adm-btn adm-btn-ghost adm-btn-sm justify-center text-xs"
                    >
                      <Download size={13} />
                      <span>{warehouseDownloading === feed.id ? 'Exporting...' : 'Export JSON Feed'}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
