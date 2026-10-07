'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ClipboardCheck,
  UserCheck,
  UserMinus,
  Plus,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  Search,
  Check,
  User,
  Shield,
  Laptop,
  Briefcase,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/editorial-common.css';

interface OnboardingTask {
  id: string;
  checklistId: string;
  title: string;
  description?: string | null;
  ownerRole: string;
  ownerUserId?: string | null;
  dueDate?: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED';
  completedAt?: string | null;
  completedById?: string | null;
  note?: string | null;
  documentId?: string | null;
}

interface OnboardingChecklist {
  id: string;
  employeeId: string;
  kind: 'ONBOARDING' | 'OFFBOARDING';
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  referenceDate?: string | null;
  createdById?: string | null;
  createdAt: string;
  tasks: OnboardingTask[];
}

interface EmployeeOption {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber?: string;
  email: string;
  department?: { name: string };
}

export default function OnboardingPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [checklists, setChecklists] = useState<OnboardingChecklist[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [selectedChecklist, setSelectedChecklist] = useState<OnboardingChecklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Filter tabs
  const [kindFilter, setKindFilter] = useState<'ALL' | 'ONBOARDING' | 'OFFBOARDING'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [completingTask, setCompletingTask] = useState<OnboardingTask | null>(null);
  const [assigningTask, setAssigningTask] = useState<OnboardingTask | null>(null);

  // Form states
  const [createForm, setCreateForm] = useState({
    employeeId: '',
    kind: 'ONBOARDING' as 'ONBOARDING' | 'OFFBOARDING',
    referenceDate: new Date().toISOString().split('T')[0],
  });

  const [completeNote, setCompleteNote] = useState('');
  const [assignUserId, setAssignUserId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load Checklists and Employees
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [clRes, empRes] = await Promise.all([
        api.get<OnboardingChecklist[]>('/onboarding/checklists').catch(() => []),
        canManage ? api.get<any>('/employees').catch(() => []) : Promise.resolve([]),
      ]);

      const list = Array.isArray(clRes) ? clRes : [];
      setChecklists(list);

      const empList = Array.isArray(empRes) ? empRes : Array.isArray(empRes?.items) ? empRes.items : [];
      setEmployees(empList);

      if (list.length > 0) {
        setSelectedChecklist((prev) => (prev ? list.find((c) => c.id === prev.id) || list[0] : list[0]));
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load onboarding checklists.');
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateChecklist = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      setError(null);

      const created = await api.post<OnboardingChecklist>('/onboarding/checklists', {
        employeeId: createForm.employeeId,
        kind: createForm.kind,
        referenceDate: createForm.referenceDate || undefined,
      });

      setShowCreateModal(false);
      setCreateForm({
        employeeId: '',
        kind: 'ONBOARDING',
        referenceDate: new Date().toISOString().split('T')[0],
      });
      setActionSuccess(`${created.kind === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'} checklist initiated successfully.`);
      await loadData();
      setSelectedChecklist(created);
    } catch (err: any) {
      setError(err?.message || 'Failed to create checklist.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteTask = async (task: OnboardingTask) => {
    try {
      setSubmitting(true);
      setError(null);
      await api.patch(`/onboarding/tasks/${task.id}/complete`, {
        note: completeNote.trim() || undefined,
      });
      setCompletingTask(null);
      setCompleteNote('');
      setActionSuccess(`Task "${task.title}" marked as complete.`);
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to complete task.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningTask || !assignUserId) return;
    try {
      setSubmitting(true);
      setError(null);
      await api.patch(`/onboarding/tasks/${assigningTask.id}/assign`, {
        ownerUserId: assignUserId,
      });
      setAssigningTask(null);
      setAssignUserId('');
      setActionSuccess(`Task re-assigned successfully.`);
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to assign task.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredChecklists = useMemo(() => {
    return checklists.filter((c) => {
      const matchesKind = kindFilter === 'ALL' || c.kind === kindFilter;
      const emp = employees.find((e) => e.id === c.employeeId);
      const empName = emp ? `${emp.firstName} ${emp.lastName}`.toLowerCase() : '';
      const matchesSearch =
        c.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.employeeId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        empName.includes(searchQuery.toLowerCase());
      return matchesKind && matchesSearch;
    });
  }, [checklists, kindFilter, searchQuery, employees]);

  const getEmployeeName = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.firstName} ${emp.lastName}` : `Personnel #${empId.slice(0, 8)}`;
  };

  const getOwnerIcon = (role: string) => {
    switch (role?.toUpperCase()) {
      case 'IT':
        return <Laptop size={13} style={{ color: 'var(--edit-info)' }} />;
      case 'MANAGER':
        return <Briefcase size={13} style={{ color: 'var(--edit-warning)' }} />;
      case 'EMPLOYEE':
        return <User size={13} style={{ color: 'var(--edit-positive)' }} />;
      default:
        return <Shield size={13} style={{ color: 'var(--edit-purple)' }} />;
    }
  };

  const totalOnboarding = useMemo(
    () => checklists.filter((c) => c.kind === 'ONBOARDING').length,
    [checklists],
  );
  const totalOffboarding = useMemo(
    () => checklists.filter((c) => c.kind === 'OFFBOARDING').length,
    [checklists],
  );
  const activeChecklists = useMemo(
    () => checklists.filter((c) => c.status === 'IN_PROGRESS').length,
    [checklists],
  );

  return (
    <DashboardLayout title="Onboarding & Offboarding Lifecycle">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">Onboarding & Offboarding Lifecycle</h1>
                <p className="editorial-subtitle">
                  Structured employee induction checklists, hardware and identity provisioning, role milestones, and exit handovers.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <ClipboardCheck size={14} style={{ color: 'var(--edit-accent)' }} />
                  <span>In Progress:</span>
                  <span className="count">{activeChecklists}</span>
                </div>
                <div className="editorial-stat-pill">
                  <span>Total Checklists:</span>
                  <span className="count">{checklists.length}</span>
                </div>
                {canManage && (
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="editorial-btn-primary"
                  >
                    <Plus size={15} />
                    <span>Start New Checklist</span>
                  </button>
                )}
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

          {/* Metric Cards Grid */}
          <div className="editorial-quick-stats">
            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Active Workflows</div>
                <div className="editorial-quick-stat-value">{activeChecklists}</div>
                <div className="editorial-quick-stat-sub">Pending completion</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Clock size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">New Hires Onboarding</div>
                <div className="editorial-quick-stat-value">{totalOnboarding}</div>
                <div className="editorial-quick-stat-sub">Induction & provisioning</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <UserCheck size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Offboarding Exits</div>
                <div className="editorial-quick-stat-value">{totalOffboarding}</div>
                <div className="editorial-quick-stat-sub">Asset retrieval & revokes</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <UserMinus size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Total Lifecycle Checklists</div>
                <div className="editorial-quick-stat-value">{checklists.length}</div>
                <div className="editorial-quick-stat-sub">Historical audit logs</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <ClipboardCheck size={18} />
              </div>
            </div>
          </div>

          {/* Two-Column Explorer Layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', alignItems: 'start' }}>
            {/* Left Column: Checklists Catalog */}
            <div
              style={{
                background: 'var(--edit-surface)',
                border: '1px solid var(--edit-border)',
                borderRadius: 'var(--edit-radius-lg)',
                padding: '16px',
                boxShadow: 'var(--edit-shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', margin: 0, fontWeight: 400 }}>
                  Lifecycle Checklists
                </h2>
                <span className="editorial-stat-pill" style={{ padding: '2px 8px', fontSize: '11px' }}>
                  {filteredChecklists.length}
                </span>
              </div>

              {/* Search & Kind Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="editorial-search-container" style={{ maxWidth: '100%' }}>
                  <Search className="editorial-search-icon" />
                  <input
                    type="text"
                    placeholder="Search personnel..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="editorial-search-input"
                    style={{ fontSize: '12px', padding: '6px 10px 6px 32px' }}
                  />
                </div>

                <div className="editorial-filter-pills" style={{ gap: '4px' }}>
                  {(['ALL', 'ONBOARDING', 'OFFBOARDING'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setKindFilter(k)}
                      className={`editorial-filter-pill ${kindFilter === k ? 'active' : ''}`}
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      {k === 'ALL' ? 'All' : k === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Checklists items */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '560px', overflowY: 'auto' }}>
                {filteredChecklists.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--edit-text-tertiary)', fontSize: '12.5px' }}>
                    No checklists found matching criteria.
                  </div>
                ) : (
                  filteredChecklists.map((cl) => {
                    const isSelected = selectedChecklist?.id === cl.id;
                    const doneTasks = cl.tasks.filter((t) => t.status === 'DONE').length;
                    const totalTasks = cl.tasks.length;
                    const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
                    const empName = getEmployeeName(cl.employeeId);

                    return (
                      <div
                        key={cl.id}
                        onClick={() => setSelectedChecklist(cl)}
                        style={{
                          padding: '12px 14px',
                          borderRadius: 'var(--edit-radius-md)',
                          border: `1px solid ${isSelected ? 'var(--edit-accent)' : 'var(--edit-border-subtle)'}`,
                          background: isSelected ? 'var(--edit-accent-light)' : 'var(--edit-surface-muted)',
                          cursor: 'pointer',
                          transition: 'all var(--edit-transition-fast)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                          <div style={{ fontWeight: 600, fontSize: '13.5px', color: 'var(--edit-text-primary)' }}>
                            {empName}
                          </div>
                          <span
                            className={`editorial-badge ${
                              cl.kind === 'ONBOARDING'
                                ? 'editorial-badge-info'
                                : 'editorial-badge-warning'
                            }`}
                            style={{ fontSize: '10px', padding: '1px 6px' }}
                          >
                            {cl.kind === 'ONBOARDING' ? 'Induction' : 'Exit'}
                          </span>
                        </div>

                        {/* Progress Bar */}
                        <div style={{ marginTop: '10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--edit-text-secondary)', marginBottom: '3px' }}>
                            <span>Progress</span>
                            <span className="editorial-mono" style={{ fontWeight: 600 }}>
                              {doneTasks}/{totalTasks} ({pct}%)
                            </span>
                          </div>
                          <div
                            style={{
                              height: '5px',
                              borderRadius: '3px',
                              background: 'var(--edit-border-subtle)',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: '100%',
                                background: pct === 100 ? 'var(--edit-positive)' : 'var(--edit-accent)',
                                transition: 'width 0.3s ease',
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Column: Selected Checklist & Tasks */}
            <div
              style={{
                background: 'var(--edit-surface)',
                border: '1px solid var(--edit-border)',
                borderRadius: 'var(--edit-radius-lg)',
                padding: '20px',
                boxShadow: 'var(--edit-shadow-sm)',
                display: 'flex',
                flexDirection: 'column',
                gap: '18px',
              }}
            >
              {selectedChecklist ? (
                <>
                  {/* Selected Checklist Header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid var(--edit-border-subtle)',
                      paddingBottom: '16px',
                      flexWrap: 'wrap',
                      gap: '12px',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <h2 style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '24px', margin: 0, fontWeight: 400 }}>
                          {getEmployeeName(selectedChecklist.employeeId)}
                        </h2>
                        <span
                          className={`editorial-badge ${
                            selectedChecklist.kind === 'ONBOARDING'
                              ? 'editorial-badge-info'
                              : 'editorial-badge-warning'
                          }`}
                        >
                          {selectedChecklist.kind}
                        </span>
                        <span
                          className={`editorial-badge ${
                            selectedChecklist.status === 'COMPLETED'
                              ? 'editorial-badge-positive'
                              : 'editorial-badge-neutral'
                          }`}
                        >
                          {selectedChecklist.status}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--edit-text-secondary)', marginTop: '4px' }}>
                        Reference Date:{' '}
                        <span className="editorial-mono" style={{ fontWeight: 600 }}>
                          {selectedChecklist.referenceDate || selectedChecklist.createdAt.split('T')[0]}
                        </span>{' '}
                        • Total Tasks: <span className="editorial-mono">{selectedChecklist.tasks.length}</span>
                      </div>
                    </div>

                    {/* Progress summary badge */}
                    {(() => {
                      const done = selectedChecklist.tasks.filter((t) => t.status === 'DONE').length;
                      const tot = selectedChecklist.tasks.length;
                      const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
                      return (
                        <div
                          style={{
                            padding: '6px 14px',
                            borderRadius: 'var(--edit-radius-md)',
                            background: 'var(--edit-accent-light)',
                            border: '1px solid var(--edit-accent-muted)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <span style={{ fontSize: '12px', color: 'var(--edit-accent)', fontWeight: 600 }}>
                            Completion Rate:
                          </span>
                          <span className="editorial-mono" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--edit-accent)' }}>
                            {pct}%
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Tasks List */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--edit-text-primary)' }}>
                      Actionable Checklist Tasks
                    </div>

                    {selectedChecklist.tasks.map((task) => {
                      const isDone = task.status === 'DONE';
                      return (
                        <div
                          key={task.id}
                          style={{
                            padding: '14px 16px',
                            borderRadius: 'var(--edit-radius-md)',
                            border: '1px solid var(--edit-border)',
                            background: isDone ? 'var(--edit-surface-muted)' : 'var(--edit-surface)',
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: '14px',
                            transition: 'all var(--edit-transition-fast)',
                            opacity: isDone ? 0.8 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                            <div
                              style={{
                                width: '22px',
                                height: '22px',
                                borderRadius: '50%',
                                border: `2px solid ${isDone ? 'var(--edit-positive)' : 'var(--edit-border)'}`,
                                background: isDone ? 'var(--edit-positive)' : 'transparent',
                                color: '#ffffff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginTop: '1px',
                                flexShrink: 0,
                              }}
                            >
                              {isDone && <Check size={13} />}
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <div
                                style={{
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  color: 'var(--edit-text-primary)',
                                  textDecoration: isDone ? 'line-through' : 'none',
                                }}
                              >
                                {task.title}
                              </div>
                              {task.description && (
                                <div style={{ fontSize: '12.5px', color: 'var(--edit-text-secondary)' }}>
                                  {task.description}
                                </div>
                              )}

                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '2px', fontSize: '11px', color: 'var(--edit-text-tertiary)' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                  {getOwnerIcon(task.ownerRole)}
                                  <span style={{ fontWeight: 600 }}>{task.ownerRole}</span>
                                </span>
                                {task.dueDate && (
                                  <span className="editorial-mono">Due: {task.dueDate}</span>
                                )}
                                {task.completedAt && (
                                  <span className="editorial-mono" style={{ color: 'var(--edit-positive)' }}>
                                    Completed: {task.completedAt.split('T')[0]}
                                  </span>
                                )}
                              </div>

                              {task.note && (
                                <div style={{ marginTop: '4px', fontSize: '11.5px', fontStyle: 'italic', color: 'var(--edit-text-secondary)' }}>
                                  Note: &ldquo;{task.note}&rdquo;
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Action Button */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                            {!isDone && canManage && (
                              <button
                                onClick={() => setCompletingTask(task)}
                                className="editorial-btn-primary"
                                style={{ fontSize: '11px', padding: '4px 10px' }}
                              >
                                <Check size={12} />
                                <span>Complete</span>
                              </button>
                            )}
                            {canManage && (
                              <button
                                onClick={() => {
                                  setAssigningTask(task);
                                  setAssignUserId(task.ownerUserId || '');
                                }}
                                className="editorial-btn-ghost"
                                style={{ fontSize: '11px', padding: '4px 8px' }}
                              >
                                Re-assign
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                  <ClipboardCheck size={36} style={{ margin: '0 auto 12px', color: 'var(--edit-text-tertiary)' }} />
                  <div style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', color: 'var(--edit-text-primary)' }}>
                    No checklist selected
                  </div>
                  <p style={{ fontSize: '13px', marginTop: '4px' }}>
                    Select an induction or exit checklist from the left panel to review task milestones.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Modal 1: Start New Checklist */}
          {showCreateModal && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Start Lifecycle Checklist</h3>
                    <p className="editorial-modal-subtitle">Initiate structured onboarding induction or offboarding exit milestones.</p>
                  </div>
                  <button onClick={() => setShowCreateModal(false)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleCreateChecklist}>
                  <div className="editorial-modal-body">
                    <div className="editorial-form-group">
                      <label className="editorial-label">Select Employee *</label>
                      <select
                        required
                        value={createForm.employeeId}
                        onChange={(e) => setCreateForm({ ...createForm, employeeId: e.target.value })}
                        className="editorial-select"
                      >
                        <option value="">Select Personnel...</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.firstName} {emp.lastName} ({emp.employeeNumber || emp.email})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                      <div className="editorial-form-group">
                        <label className="editorial-label">Checklist Kind *</label>
                        <select
                          value={createForm.kind}
                          onChange={(e) => setCreateForm({ ...createForm, kind: e.target.value as any })}
                          className="editorial-select"
                        >
                          <option value="ONBOARDING">New Hire Induction</option>
                          <option value="OFFBOARDING">Exit Separation Handover</option>
                        </select>
                      </div>

                      <div className="editorial-form-group">
                        <label className="editorial-label">Effective Date *</label>
                        <input
                          required
                          type="date"
                          value={createForm.referenceDate}
                          onChange={(e) => setCreateForm({ ...createForm, referenceDate: e.target.value })}
                          className="editorial-input"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setShowCreateModal(false)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting || !createForm.employeeId} className="editorial-btn-primary">
                      {submitting ? 'Initiating...' : 'Initiate Checklist'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal 2: Complete Task */}
          {completingTask && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Complete Checklist Task</h3>
                    <p className="editorial-modal-subtitle">{completingTask.title}</p>
                  </div>
                  <button onClick={() => setCompletingTask(null)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <div className="editorial-modal-body">
                  <div className="editorial-form-group">
                    <label className="editorial-label">Completion Remarks / Resolution Note</label>
                    <textarea
                      rows={3}
                      placeholder="e.g. MacBook Pro issued, Slack/Google Workspace accounts provisioned..."
                      value={completeNote}
                      onChange={(e) => setCompleteNote(e.target.value)}
                      className="editorial-textarea"
                    />
                  </div>
                </div>

                <div className="editorial-modal-footer">
                  <button type="button" onClick={() => setCompletingTask(null)} className="editorial-btn-secondary">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCompleteTask(completingTask)}
                    disabled={submitting}
                    className="editorial-btn-primary"
                  >
                    {submitting ? 'Saving...' : 'Confirm Completed'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Modal 3: Reassign Task */}
          {assigningTask && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Reassign Task Owner</h3>
                    <p className="editorial-modal-subtitle">{assigningTask.title}</p>
                  </div>
                  <button onClick={() => setAssigningTask(null)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleAssignTask}>
                  <div className="editorial-modal-body">
                    <div className="editorial-form-group">
                      <label className="editorial-label">Assignee Personnel *</label>
                      <select
                        required
                        value={assignUserId}
                        onChange={(e) => setAssignUserId(e.target.value)}
                        className="editorial-select"
                      >
                        <option value="">Select Assignee...</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.firstName} {emp.lastName} ({emp.department?.name || 'Staff'})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setAssigningTask(null)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting || !assignUserId} className="editorial-btn-primary">
                      {submitting ? 'Saving...' : 'Confirm Reassignment'}
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
