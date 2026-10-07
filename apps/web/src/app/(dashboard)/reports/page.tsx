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
  CheckCircle2,
  AlertCircle,
  X,
  Play,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/editorial-common.css';

interface Department {
  id: string;
  name: string;
  code: string;
}

interface ReportConfig {
  type: 'headcount' | 'turnover' | 'absence' | 'overtime' | 'payroll-cost';
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  tag: string;
  tagClass: string;
}

const STANDARD_REPORTS: ReportConfig[] = [
  {
    type: 'headcount',
    title: 'Headcount & Workforce Demographics',
    subtitle: 'Point-in-time active personnel census categorized by department and job designation.',
    icon: Users,
    tag: 'Workforce Census',
    tagClass: 'editorial-badge-info',
  },
  {
    type: 'turnover',
    title: 'Turnover & Leavers Analysis',
    subtitle: 'Point-in-time separation metrics, leaver trends, and departmental attrition ratios.',
    icon: UserX,
    tag: 'Retention',
    tagClass: 'editorial-badge-rose',
  },
  {
    type: 'absence',
    title: 'Absence & Leave Utilization',
    subtitle: 'Unplanned absence records, leave frequency rates, and operational time deficits.',
    icon: Clock,
    tag: 'Operations',
    tagClass: 'editorial-badge-warning',
  },
  {
    type: 'overtime',
    title: 'Overtime & Extended Hours',
    subtitle: 'Cumulative hours logged beyond scheduled shift thresholds and duty rotations.',
    icon: BarChart3,
    tag: 'Productivity',
    tagClass: 'editorial-badge-purple',
  },
  {
    type: 'payroll-cost',
    title: 'Payroll Expenditure & Statutory Costs',
    subtitle: 'Comprehensive gross wage disbursements, employer NI contributions, and statutory sums.',
    icon: Banknote,
    tag: 'Finance & Tax',
    tagClass: 'editorial-badge-positive',
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
    format: 'csv' | 'xlsx' | 'pdf',
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

      setActionSuccess(`Generated and downloaded ${filename}`);
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
    <DashboardLayout title="Reports & Business Intelligence">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">Reports & Business Intelligence</h1>
                <p className="editorial-subtitle">
                  Workforce headcount census, turnover analysis, payroll expenditure journals, and ad-hoc data warehouse exports.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <BarChart3 size={14} style={{ color: 'var(--edit-accent)' }} />
                  <span>BI Engine:</span>
                  <span className="count">Operational</span>
                </div>
                <div className="editorial-stat-pill">
                  <span>Models:</span>
                  <span className="count">5 Core Models</span>
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
                <div className="editorial-quick-stat-label">Executive Reports</div>
                <div className="editorial-quick-stat-value">5 Models</div>
                <div className="editorial-quick-stat-sub">CSV, Excel & PDF formats</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <FileText size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Active Timeframe</div>
                <div className="editorial-quick-stat-value">30 Days</div>
                <div className="editorial-quick-stat-sub">Configurable date window</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Calendar size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Ad-Hoc Explorer</div>
                <div className="editorial-quick-stat-value">Real-Time</div>
                <div className="editorial-quick-stat-sub">Cross-entity dataset query</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Database size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Warehouse Feeds</div>
                <div className="editorial-quick-stat-value">Automated</div>
                <div className="editorial-quick-stat-sub">Clean JSON snapshot sync</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <FileSpreadsheet size={18} />
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="editorial-tabs">
            <button
              onClick={() => setActiveTab('standard')}
              className={`editorial-tab ${activeTab === 'standard' ? 'active' : ''}`}
            >
              <span>Standard Executive Reports</span>
            </button>
            <button
              onClick={() => setActiveTab('adhoc')}
              className={`editorial-tab ${activeTab === 'adhoc' ? 'active' : ''}`}
            >
              <span>Ad-Hoc Query Explorer</span>
            </button>
            {hasRole(SystemRole.SUPER_ADMIN, SystemRole.AUDITOR) && (
              <button
                onClick={() => setActiveTab('warehouse')}
                className={`editorial-tab ${activeTab === 'warehouse' ? 'active' : ''}`}
              >
                <span>Data Warehouse Pipeline</span>
              </button>
            )}
          </div>

          {/* Tab 1: Standard Executive Reports */}
          {activeTab === 'standard' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Parameters Toolbar */}
              <div className="editorial-toolbar">
                <div className="editorial-toolbar-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Calendar size={14} style={{ color: 'var(--edit-text-tertiary)' }} />
                      <span className="editorial-label" style={{ margin: 0 }}>Report Window:</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="date"
                        value={fromDate}
                        onChange={(e) => setFromDate(e.target.value)}
                        className="editorial-input editorial-mono"
                        style={{ padding: '6px 10px', fontSize: '12px', width: '135px' }}
                      />
                      <span style={{ fontSize: '12px', color: 'var(--edit-text-tertiary)' }}>to</span>
                      <input
                        type="date"
                        value={toDate}
                        onChange={(e) => setToDate(e.target.value)}
                        className="editorial-input editorial-mono"
                        style={{ padding: '6px 10px', fontSize: '12px', width: '135px' }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Building2 size={14} style={{ color: 'var(--edit-text-tertiary)' }} />
                    <select
                      value={selectedDept}
                      onChange={(e) => setSelectedDept(e.target.value)}
                      className="editorial-select"
                      style={{ padding: '6px 12px', fontSize: '12px', width: '220px' }}
                    >
                      <option value="">All Departments</option>
                      {departments.map((dept) => (
                        <option key={dept.id} value={dept.id}>
                          {dept.name} ({dept.code})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Standard Reports Grid */}
              <div className="editorial-grid">
                {STANDARD_REPORTS.map((report) => {
                  const IconComponent = report.icon;
                  const isDownloading = downloadingType?.startsWith(report.type);
                  return (
                    <div key={report.type} className="editorial-card">
                      <div>
                        <div className="editorial-card-top">
                          <div
                            style={{
                              width: '38px',
                              height: '38px',
                              borderRadius: 'var(--edit-radius-sm)',
                              background: 'var(--edit-surface-muted)',
                              border: '1px solid var(--edit-border-subtle)',
                              color: 'var(--edit-accent)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <IconComponent size={20} />
                          </div>
                          <span className={`editorial-badge ${report.tagClass}`}>
                            {report.tag}
                          </span>
                        </div>

                        <div className="editorial-card-title">{report.title}</div>
                        <div className="editorial-card-desc">{report.subtitle}</div>
                      </div>

                      <div className="editorial-card-meta" style={{ flexDirection: 'column', gap: '10px', alignItems: 'stretch' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--edit-text-tertiary)' }}>
                          <span>Export Formats</span>
                          <span className="editorial-mono">CSV • XLSX • PDF</span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                          <button
                            onClick={() => handleDownloadStandard(report.type, 'csv')}
                            disabled={isDownloading}
                            className="editorial-btn-secondary"
                            style={{ fontSize: '11px', padding: '5px 8px', justifyContent: 'center' }}
                          >
                            <Download size={12} />
                            <span>CSV</span>
                          </button>
                          <button
                            onClick={() => handleDownloadStandard(report.type, 'xlsx')}
                            disabled={isDownloading}
                            className="editorial-btn-secondary"
                            style={{ fontSize: '11px', padding: '5px 8px', justifyContent: 'center' }}
                          >
                            <FileSpreadsheet size={12} />
                            <span>Excel</span>
                          </button>
                          <button
                            onClick={() => handleDownloadStandard(report.type, 'pdf')}
                            disabled={isDownloading}
                            className="editorial-btn-secondary"
                            style={{ fontSize: '11px', padding: '5px 8px', justifyContent: 'center' }}
                          >
                            <FileText size={12} />
                            <span>PDF</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 2: Ad-Hoc Query Explorer */}
          {activeTab === 'adhoc' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="editorial-toolbar">
                <div className="editorial-toolbar-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Database size={15} style={{ color: 'var(--edit-accent)' }} />
                      <span className="editorial-label" style={{ margin: 0 }}>Target Entity:</span>
                      <select
                        value={adhocEntity}
                        onChange={(e) => setAdhocEntity(e.target.value as any)}
                        className="editorial-select"
                        style={{ padding: '6px 12px', fontSize: '12.5px', width: '160px' }}
                      >
                        <option value="employees">Personnel Directory</option>
                        <option value="leaves">Leave Records</option>
                        <option value="attendance">Clock-In Telemetry</option>
                        <option value="payroll">Payroll Ledger</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="editorial-label" style={{ margin: 0 }}>Limit:</span>
                      <select
                        value={adhocLimit}
                        onChange={(e) => setAdhocLimit(Number(e.target.value))}
                        className="editorial-select"
                        style={{ padding: '6px 10px', fontSize: '12.5px', width: '100px' }}
                      >
                        <option value={25}>25 Rows</option>
                        <option value={50}>50 Rows</option>
                        <option value={100}>100 Rows</option>
                      </select>
                    </div>
                  </div>

                  <button
                    onClick={handleRunAdHoc}
                    disabled={adhocRunning}
                    className="editorial-btn-primary"
                  >
                    <Play size={14} />
                    <span>{adhocRunning ? 'Executing Query...' : 'Execute Ad-Hoc Query'}</span>
                  </button>
                </div>
              </div>

              {/* Results Table */}
              {adhocResults && (
                <div className="editorial-table-wrapper">
                  <div
                    style={{
                      padding: '16px 20px',
                      borderBottom: '1px solid var(--edit-border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <h3 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                        Query Dataset Preview: {adhocEntity.toUpperCase()}
                      </h3>
                      <div style={{ fontSize: '12px', color: 'var(--edit-text-secondary)', marginTop: '2px' }}>
                        Showing {adhocResults.length} records retrieved in real-time
                      </div>
                    </div>
                  </div>

                  {adhocResults.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                      No records matched the dataset query.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto', maxHeight: '520px' }}>
                      <table className="editorial-table">
                        <thead>
                          <tr>
                            {Object.keys(adhocResults[0] || {}).slice(0, 7).map((col) => (
                              <th key={col}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {adhocResults.map((row, idx) => (
                            <tr key={idx}>
                              {Object.keys(row).slice(0, 7).map((col) => {
                                const val = row[col];
                                const display =
                                  val === null || val === undefined
                                    ? '—'
                                    : typeof val === 'object'
                                    ? JSON.stringify(val)
                                    : String(val);
                                return (
                                  <td key={col} className="editorial-mono" style={{ fontSize: '12px' }}>
                                    {display.length > 45 ? `${display.slice(0, 45)}...` : display}
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
              )}
            </div>
          )}

          {/* Tab 3: Data Warehouse Pipeline */}
          {activeTab === 'warehouse' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
              {[
                { key: 'employees', label: 'Employees Master Data', desc: 'Normalized profiles, contracts, and hierarchy.', icon: Users },
                { key: 'payroll', label: 'Historical Payroll Cycles', desc: 'Disbursements, tax deductions, and ledger balances.', icon: Banknote },
                { key: 'leaves', label: 'Leave Accrual & Balances', desc: 'Entitlements, taken leaves, and holiday calendars.', icon: Calendar },
                { key: 'audit', label: 'System Security Audit Logs', desc: 'Cryptographic security actions, sessions, and roles.', icon: Clock },
              ].map((feed) => {
                const IconComp = feed.icon;
                const isDownloading = warehouseDownloading === feed.key;
                return (
                  <div key={feed.key} className="editorial-card">
                    <div>
                      <div className="editorial-card-top">
                        <div
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: 'var(--edit-radius-sm)',
                            background: 'var(--edit-surface-muted)',
                            border: '1px solid var(--edit-border-subtle)',
                            color: 'var(--edit-accent)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <IconComp size={18} />
                        </div>
                        <span className="editorial-badge editorial-badge-neutral">JSON Feed</span>
                      </div>

                      <div className="editorial-card-title">{feed.label}</div>
                      <div className="editorial-card-desc">{feed.desc}</div>
                    </div>

                    <div className="editorial-card-meta">
                      <span style={{ fontSize: '11.5px', color: 'var(--edit-text-tertiary)' }}>
                        Automated Daily ETL
                      </span>
                      <button
                        onClick={() => handleWarehouseExport(feed.key)}
                        disabled={isDownloading}
                        className="editorial-btn-secondary"
                        style={{ fontSize: '11.5px', padding: '5px 12px' }}
                      >
                        <Download size={12} />
                        <span>{isDownloading ? 'Exporting...' : 'Export Snapshot'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
