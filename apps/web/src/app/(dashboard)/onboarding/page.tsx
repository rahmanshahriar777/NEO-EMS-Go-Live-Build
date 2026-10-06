'use client';

import React, { useState, useEffect, useCallback } from 'react';
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
  Filter,
  Check,
  Calendar,
  User,
  Shield,
  Laptop,
  Briefcase,
  FileText,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/admin.css';

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
  const { user, hasRole } = useAuth();
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

  const filteredChecklists = checklists.filter((c) => {
    const matchesKind = kindFilter === 'ALL' || c.kind === kindFilter;
    const emp = employees.find((e) => e.id === c.employeeId);
    const empName = emp ? `${emp.firstName} ${emp.lastName}`.toLowerCase() : '';
    const matchesSearch =
      c.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.employeeId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      empName.includes(searchQuery.toLowerCase());
    return matchesKind && matchesSearch;
  });

  const getEmployeeName = (empId: string) => {
    const emp = employees.find((e) => e.id === empId);
    return emp ? `${emp.firstName} ${emp.lastName}` : `Employee (${empId.slice(0, 8)})`;
  };

  const getOwnerIcon = (role: string) => {
    switch (role?.toUpperCase()) {
      case 'IT':
        return <Laptop size={13} className="text-cyan-700" />;
      case 'MANAGER':
        return <Briefcase size={13} className="text-amber-700" />;
      case 'EMPLOYEE':
        return <User size={13} className="text-emerald-700" />;
      default:
        return <Shield size={13} className="text-purple-700" />;
    }
  };

  const totalOnboarding = checklists.filter((c) => c.kind === 'ONBOARDING').length;
  const totalOffboarding = checklists.filter((c) => c.kind === 'OFFBOARDING').length;
  const activeChecklists = checklists.filter((c) => c.status === 'IN_PROGRESS').length;

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Header */}
        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-purple-50 text-purple-700">
                <ClipboardCheck size={22} />
              </span>
              <h1 className="adm-title">Onboarding & Offboarding Lifecycle</h1>
            </div>
            <p className="adm-subtitle">
              Standardised employee induction workflows, IT asset provisioning, department transitions, and exit checklists.
            </p>
          </div>

          {canManage && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="adm-btn adm-btn-primary"
            >
              <Plus size={16} />
              <span>Start New Checklist</span>
            </button>
          )}
        </div>

        {/* Notifications */}
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

        {/* Top Metric Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-purple-50 text-purple-700">
              <ClipboardCheck size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Checklists</div>
              <div className="text-2xl font-bold text-gray-900">{checklists.length}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-blue-50 text-blue-700">
              <Clock size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">In Progress</div>
              <div className="text-2xl font-bold text-gray-900">{activeChecklists}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-emerald-50 text-emerald-700">
              <UserCheck size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Onboarding</div>
              <div className="text-2xl font-bold text-gray-900">{totalOnboarding}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-amber-50 text-amber-700">
              <UserMinus size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Offboarding</div>
              <div className="text-2xl font-bold text-gray-900">{totalOffboarding}</div>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Checklists Navigation List */}
          <div className="lg:col-span-5 adm-card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">Active Checklists</h2>
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-semibold">
                {filteredChecklists.length}
              </span>
            </div>

            {/* Filter Buttons */}
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by employee..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="adm-input pl-9 text-xs"
                />
              </div>

              <div className="flex gap-1 p-1 bg-gray-100 rounded-lg text-xs font-semibold text-gray-600">
                {(['ALL', 'ONBOARDING', 'OFFBOARDING'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setKindFilter(k)}
                    className={`flex-1 py-1 text-center rounded-md transition-all ${
                      kindFilter === k ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
                    }`}
                  >
                    {k === 'ALL' ? 'All' : k === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'}
                  </button>
                ))}
              </div>
            </div>

            {/* Checklist items list */}
            <div className="flex flex-col gap-2 max-h-[560px] overflow-y-auto pr-1">
              {filteredChecklists.length === 0 ? (
                <div className="adm-empty">No checklists found.</div>
              ) : (
                filteredChecklists.map((cl) => {
                  const isSelected = selectedChecklist?.id === cl.id;
                  const totalTasks = cl.tasks?.length || 0;
                  const doneTasks = cl.tasks?.filter((t) => t.status === 'DONE').length || 0;
                  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

                  return (
                    <div
                      key={cl.id}
                      onClick={() => setSelectedChecklist(cl)}
                      className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                        isSelected
                          ? 'border-purple-600 bg-purple-50/30 shadow-sm ring-1 ring-purple-600'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-sm text-gray-900">
                          {getEmployeeName(cl.employeeId)}
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            cl.kind === 'ONBOARDING'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {cl.kind}
                        </span>
                      </div>

                      {/* Progress Bar */}
                      <div className="mt-2.5 flex flex-col gap-1">
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>Progress</span>
                          <span className="font-semibold text-gray-700">
                            {doneTasks}/{totalTasks} ({percent}%)
                          </span>
                        </div>
                        <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              percent === 100 ? 'bg-emerald-500' : 'bg-purple-600'
                            }`}
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
                        <span>
                          {cl.referenceDate ? `Target: ${cl.referenceDate.split('T')[0]}` : 'Ongoing'}
                        </span>
                        <span
                          className={`font-semibold ${
                            cl.status === 'COMPLETED' ? 'text-emerald-600' : 'text-blue-600'
                          }`}
                        >
                          {cl.status}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Checklist Detail View & Task Checkboxes */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            {selectedChecklist ? (
              <div className="adm-card flex flex-col gap-5">
                {/* Checklist Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-gray-900">
                        {getEmployeeName(selectedChecklist.employeeId)}
                      </h2>
                      <span
                        className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                          selectedChecklist.kind === 'ONBOARDING'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {selectedChecklist.kind}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-500 mt-1">
                      <span>Checklist ID: {selectedChecklist.id.slice(0, 13)}...</span>
                      {selectedChecklist.referenceDate && (
                        <span>Reference Date: {selectedChecklist.referenceDate.split('T')[0]}</span>
                      )}
                    </div>
                  </div>

                  <span
                    className={`text-xs font-bold px-3 py-1 rounded-full ${
                      selectedChecklist.status === 'COMPLETED'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {selectedChecklist.status}
                  </span>
                </div>

                {/* Task Checklist Items */}
                <div className="flex flex-col gap-3">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                    Tasks & Milestones ({selectedChecklist.tasks?.filter((t) => t.status === 'DONE').length || 0} /{' '}
                    {selectedChecklist.tasks?.length || 0})
                  </div>

                  {selectedChecklist.tasks?.length === 0 ? (
                    <div className="adm-empty">No tasks defined for this checklist.</div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {selectedChecklist.tasks?.map((task) => {
                        const isDone = task.status === 'DONE';
                        return (
                          <div
                            key={task.id}
                            className={`p-3.5 rounded-xl border transition-all ${
                              isDone
                                ? 'bg-gray-50/80 border-gray-200 opacity-80'
                                : 'bg-white border-gray-200 hover:border-purple-300 shadow-sm'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              {/* Checkbox */}
                              <button
                                type="button"
                                disabled={isDone || submitting}
                                onClick={() => setCompletingTask(task)}
                                className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center transition-all ${
                                  isDone
                                    ? 'bg-emerald-600 text-white cursor-default'
                                    : 'border-2 border-gray-300 hover:border-purple-600 text-transparent'
                                }`}
                              >
                                <Check size={13} strokeWidth={3} className={isDone ? 'block' : 'hidden'} />
                              </button>

                              {/* Task Details */}
                              <div className="flex-1 flex flex-col gap-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span
                                    className={`text-sm font-semibold ${
                                      isDone ? 'line-through text-gray-500' : 'text-gray-900'
                                    }`}
                                  >
                                    {task.title}
                                  </span>

                                  <div className="flex items-center gap-2">
                                    <span className="flex items-center gap-1 text-[11px] font-semibold bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                                      {getOwnerIcon(task.ownerRole)}
                                      <span>{task.ownerRole}</span>
                                    </span>

                                    {canManage && !isDone && (
                                      <button
                                        type="button"
                                        onClick={() => setAssigningTask(task)}
                                        className="text-[11px] text-purple-700 hover:underline"
                                      >
                                        Assign
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {task.description && (
                                  <p className="text-xs text-gray-500">{task.description}</p>
                                )}

                                <div className="mt-1 flex items-center gap-4 text-[11px] text-gray-400">
                                  {task.dueDate && (
                                    <span className="flex items-center gap-1">
                                      <Calendar size={11} />
                                      Due: {task.dueDate.split('T')[0]}
                                    </span>
                                  )}
                                  {isDone && task.completedAt && (
                                    <span className="text-emerald-700 font-medium">
                                      Completed on {task.completedAt.split('T')[0]}
                                    </span>
                                  )}
                                  {task.note && (
                                    <span className="text-gray-600 italic">Note: "{task.note}"</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="adm-card adm-empty py-16">
                <ClipboardCheck size={36} className="mx-auto text-gray-300 mb-2" />
                <p>Select a checklist from the left panel to review and complete induction or exit tasks.</p>
              </div>
            )}
          </div>
        </div>

        {/* Modal 1: Create New Checklist */}
        {showCreateModal && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Start New Checklist</h3>
                <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Initialise a standard onboarding or offboarding workflow for an employee.
              </p>

              <form onSubmit={handleCreateChecklist}>
                <div className="adm-form-group">
                  <label className="adm-label">Employee *</label>
                  <select
                    required
                    value={createForm.employeeId}
                    onChange={(e) => setCreateForm({ ...createForm, employeeId: e.target.value })}
                    className="adm-select"
                  >
                    <option value="">Select Employee...</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.firstName} {emp.lastName} ({emp.department?.name || 'General Org'})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Checklist Type *</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setCreateForm({ ...createForm, kind: 'ONBOARDING' })}
                      className={`p-3 rounded-xl border text-center font-semibold text-xs transition-all ${
                        createForm.kind === 'ONBOARDING'
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                          : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Onboarding (New Joiner)
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateForm({ ...createForm, kind: 'OFFBOARDING' })}
                      className={`p-3 rounded-xl border text-center font-semibold text-xs transition-all ${
                        createForm.kind === 'OFFBOARDING'
                          ? 'border-amber-600 bg-amber-50 text-amber-800'
                          : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Offboarding (Leaver)
                    </button>
                  </div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">
                    {createForm.kind === 'ONBOARDING' ? 'Start Date' : 'Last Working Day'} *
                  </label>
                  <input
                    type="date"
                    required
                    value={createForm.referenceDate}
                    onChange={(e) => setCreateForm({ ...createForm, referenceDate: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="p-3 bg-purple-50/60 rounded-xl border border-purple-100 text-xs text-purple-900 mt-2">
                  Standard enterprise task sequence will be automatically generated with role assignments (HR, IT, Manager, Employee).
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Initiating...' : 'Initiate Checklist'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal 2: Complete Task Note */}
        {completingTask && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Mark Task as Complete</h3>
                <button onClick={() => setCompletingTask(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Confirm completion of: <strong>{completingTask.title}</strong>
              </p>

              <div>
                <div className="adm-form-group">
                  <label className="adm-label">Completion Note (Optional)</label>
                  <textarea
                    rows={3}
                    placeholder="Provide confirmation details, asset tags, or verification notes..."
                    value={completeNote}
                    onChange={(e) => setCompleteNote(e.target.value)}
                    className="adm-input"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setCompletingTask(null)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => handleCompleteTask(completingTask)}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Confirming...' : 'Mark Done'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal 3: Assign Task */}
        {assigningTask && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Assign Task Owner</h3>
                <button onClick={() => setAssigningTask(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Assign specific owner user for: <strong>{assigningTask.title}</strong>
              </p>

              <form onSubmit={handleAssignTask}>
                <div className="adm-form-group">
                  <label className="adm-label">Select Assignee Employee *</label>
                  <select
                    required
                    value={assignUserId}
                    onChange={(e) => setAssignUserId(e.target.value)}
                    className="adm-select"
                  >
                    <option value="">Select Assignee...</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.firstName} {emp.lastName} ({emp.department?.name || 'General'})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setAssigningTask(null)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Saving...' : 'Save Assignment'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
