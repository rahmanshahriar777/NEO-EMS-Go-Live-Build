'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Briefcase,
  Users,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  FileCheck,
  Sparkles,
  AlertCircle,
  X,
  Mail,
  Phone,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/admin.css';

interface Vacancy {
  id: string;
  title: string;
  description?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  status: 'OPEN' | 'ON_HOLD' | 'CLOSED';
  postedAt: string;
  closedAt?: string | null;
  _count?: {
    candidates: number;
  };
}

interface Offer {
  id: string;
  candidateId: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';
  startDate?: string | null;
  salaryAmount?: number | null;
  terms?: string | null;
  createdAt: string;
}

interface Candidate {
  id: string;
  vacancyId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  stage: 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
  employeeId?: string | null;
  createdAt: string;
  offers?: Offer[];
}

interface Department {
  id: string;
  name: string;
  code: string;
}

interface Designation {
  id: string;
  title: string;
}

const STAGES: Array<{ key: Candidate['stage']; label: string; color: string; bg: string }> = [
  { key: 'APPLIED', label: 'Applied', color: '#1d4ed8', bg: '#eff6ff' },
  { key: 'SCREENING', label: 'Screening', color: '#7c3aed', bg: '#f5f3ff' },
  { key: 'INTERVIEW', label: 'Interview', color: '#b45309', bg: '#fffbeb' },
  { key: 'OFFER', label: 'Offer Sent', color: '#0d9488', bg: '#f0fdfa' },
  { key: 'HIRED', label: 'Hired', color: '#15803d', bg: '#f0fdf4' },
  { key: 'REJECTED', label: 'Archived', color: '#64748b', bg: '#f8fafc' },
];

export default function RecruitmentPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [selectedVacancy, setSelectedVacancy] = useState<Vacancy | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modals
  const [showVacancyModal, setShowVacancyModal] = useState(false);
  const [showCandidateModal, setShowCandidateModal] = useState(false);
  const [stageCandidate, setStageCandidate] = useState<Candidate | null>(null);
  const [offerCandidate, setOfferCandidate] = useState<Candidate | null>(null);

  // Form states
  const [vacancyForm, setVacancyForm] = useState({
    title: '',
    departmentId: '',
    designationId: '',
    description: '',
    status: 'OPEN',
  });

  const [candidateForm, setCandidateForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });

  const [stageForm, setStageForm] = useState({
    stage: 'SCREENING' as Candidate['stage'],
    note: '',
  });

  const [offerForm, setOfferForm] = useState({
    startDate: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
    salaryAmount: 65000,
    terms: 'Full-time permanent employment with standard benefit package.',
  });

  const [submitting, setSubmitting] = useState(false);

  // Load Vacancies, Departments, Designations
  const loadInitialData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [vacRes, deptRes, desigRes] = await Promise.all([
        api.get<Vacancy[]>('/recruitment/vacancies').catch(() => []),
        api.get<Department[]>('/departments').catch(() => []),
        api.get<Designation[]>('/designations').catch(() => []),
      ]);

      const vacList = Array.isArray(vacRes) ? vacRes : [];
      setVacancies(vacList);
      setDepartments(Array.isArray(deptRes) ? deptRes : []);
      setDesignations(Array.isArray(desigRes) ? desigRes : []);

      if (vacList.length > 0 && !selectedVacancy) {
        setSelectedVacancy(vacList[0]);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load recruitment data.');
    } finally {
      setLoading(false);
    }
  }, [selectedVacancy]);

  useEffect(() => {
    loadInitialData();
  }, []);

  // Load candidates for selected vacancy
  const loadCandidates = useCallback(async (vacancyId: string) => {
    try {
      setCandidatesLoading(true);
      const res = await api.get<Candidate[]>(`/recruitment/vacancies/${vacancyId}/candidates`);
      setCandidates(Array.isArray(res) ? res : []);
    } catch (err: any) {
      setCandidates([]);
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedVacancy?.id) {
      loadCandidates(selectedVacancy.id);
    } else {
      setCandidates([]);
    }
  }, [selectedVacancy, loadCandidates]);

  const handleCreateVacancy = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      setError(null);
      const payload: any = {
        title: vacancyForm.title.trim(),
        status: vacancyForm.status,
      };
      if (vacancyForm.description.trim()) payload.description = vacancyForm.description.trim();
      if (vacancyForm.departmentId) payload.departmentId = vacancyForm.departmentId;
      if (vacancyForm.designationId) payload.designationId = vacancyForm.designationId;

      const created = await api.post<Vacancy>('/recruitment/vacancies', payload);
      setShowVacancyModal(false);
      setVacancyForm({ title: '', departmentId: '', designationId: '', description: '', status: 'OPEN' });
      setActionSuccess(`Job opening "${created.title}" successfully created!`);
      await loadInitialData();
      setSelectedVacancy(created);
    } catch (err: any) {
      setError(err?.message || 'Failed to create vacancy.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVacancy) return;
    try {
      setSubmitting(true);
      setError(null);
      const payload = {
        vacancyId: selectedVacancy.id,
        firstName: candidateForm.firstName.trim(),
        lastName: candidateForm.lastName.trim(),
        email: candidateForm.email.trim(),
        phone: candidateForm.phone.trim() || undefined,
      };
      await api.post('/recruitment/candidates', payload);
      setShowCandidateModal(false);
      setCandidateForm({ firstName: '', lastName: '', email: '', phone: '' });
      setActionSuccess(`Candidate ${payload.firstName} ${payload.lastName} added to pipeline.`);
      loadCandidates(selectedVacancy.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to add candidate.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateStage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stageCandidate || !selectedVacancy) return;
    try {
      setSubmitting(true);
      setError(null);
      await api.patch(`/recruitment/candidates/${stageCandidate.id}/stage`, {
        stage: stageForm.stage,
        note: stageForm.note.trim() || undefined,
      });
      setStageCandidate(null);
      setActionSuccess(`Candidate advanced to ${stageForm.stage}.`);
      loadCandidates(selectedVacancy.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to advance candidate stage.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateOffer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!offerCandidate || !selectedVacancy) return;
    try {
      setSubmitting(true);
      setError(null);
      await api.post(`/recruitment/candidates/${offerCandidate.id}/offers`, {
        startDate: offerForm.startDate,
        salaryAmount: Number(offerForm.salaryAmount),
        terms: offerForm.terms.trim() || undefined,
      });
      setOfferCandidate(null);
      setActionSuccess(`Formal job offer extended to ${offerCandidate.firstName} ${offerCandidate.lastName}.`);
      loadCandidates(selectedVacancy.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to extend job offer.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcceptOffer = async (offerId: string, candidateName: string) => {
    if (!selectedVacancy) return;
    if (!confirm(`Confirm acceptance of offer for ${candidateName}? This will automatically generate a new Employee record in the directory.`)) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await api.post(`/recruitment/offers/${offerId}/accept`);
      setActionSuccess(`Offer accepted! New employee record created for ${candidateName}.`);
      loadCandidates(selectedVacancy.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to accept offer.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredVacancies = vacancies.filter((v) => {
    const matchesStatus = statusFilter === 'ALL' || v.status === statusFilter;
    const matchesSearch =
      v.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (v.description && v.description.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesStatus && matchesSearch;
  });

  const totalOpenRoles = vacancies.filter((v) => v.status === 'OPEN').length;
  const totalApplicants = vacancies.reduce((acc, v) => acc + (v._count?.candidates || 0), 0);

  return (
    <DashboardLayout>
      <div className="adm-page">
        {/* Header Section */}
        <div className="adm-header">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-emerald-50 text-emerald-700">
                <Briefcase size={22} />
              </span>
              <h1 className="adm-title">Recruitment & Talent Pipeline</h1>
            </div>
            <p className="adm-subtitle">
              Manage job vacancies, track candidate progression across recruitment stages, extend offers, and automate onboarding creation.
            </p>
          </div>

          {canManage && (
            <button
              onClick={() => setShowVacancyModal(true)}
              className="adm-btn adm-btn-primary"
            >
              <Plus size={16} />
              <span>Post New Vacancy</span>
            </button>
          )}
        </div>

        {/* Action / Error Banners */}
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

        {/* Stats Metrics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-blue-50 text-blue-700">
              <Briefcase size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Positions</div>
              <div className="text-2xl font-bold text-gray-900">{vacancies.length}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-emerald-50 text-emerald-700">
              <Sparkles size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Open Vacancies</div>
              <div className="text-2xl font-bold text-gray-900">{totalOpenRoles}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-purple-50 text-purple-700">
              <Users size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Total Applicants</div>
              <div className="text-2xl font-bold text-gray-900">{totalApplicants}</div>
            </div>
          </div>

          <div className="adm-card flex items-center gap-4">
            <div className="p-3 rounded-xl bg-amber-50 text-amber-700">
              <FileCheck size={22} />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Active Pipeline</div>
              <div className="text-2xl font-bold text-gray-900">{candidates.length}</div>
            </div>
          </div>
        </div>

        {/* Main Content Layout: Left Vacancies List, Right Pipeline Board */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Vacancies Explorer */}
          <div className="lg:col-span-4 adm-card flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">Job Openings</h2>
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-semibold">
                {filteredVacancies.length}
              </span>
            </div>

            {/* Filter controls */}
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search openings..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="adm-input pl-9 text-xs"
                />
              </div>

              <div className="flex gap-1 p-1 bg-gray-100 rounded-lg text-xs font-semibold text-gray-600">
                {(['ALL', 'OPEN', 'ON_HOLD', 'CLOSED'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatusFilter(st)}
                    className={`flex-1 py-1 text-center rounded-md transition-all ${
                      statusFilter === st ? 'bg-white text-gray-900 shadow-sm font-bold' : 'hover:text-gray-900'
                    }`}
                  >
                    {st === 'ALL' ? 'All' : st.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            {/* Vacancy Card List */}
            <div className="flex flex-col gap-2 max-h-[550px] overflow-y-auto pr-1">
              {filteredVacancies.length === 0 ? (
                <div className="adm-empty">No vacancies found matching criteria.</div>
              ) : (
                filteredVacancies.map((vac) => {
                  const isSelected = selectedVacancy?.id === vac.id;
                  const dept = departments.find((d) => d.id === vac.departmentId);
                  return (
                    <div
                      key={vac.id}
                      onClick={() => setSelectedVacancy(vac)}
                      className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                        isSelected
                          ? 'border-emerald-600 bg-emerald-50/40 shadow-sm ring-1 ring-emerald-600'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-sm text-gray-900">{vac.title}</div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            vac.status === 'OPEN'
                              ? 'bg-emerald-100 text-emerald-800'
                              : vac.status === 'ON_HOLD'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {vac.status}
                        </span>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                        <span>{dept?.name || 'General Org'}</span>
                        <span className="font-medium flex items-center gap-1 text-gray-700">
                          <Users size={12} />
                          {vac._count?.candidates ?? 0} candidates
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Column: Candidate Pipeline for Selected Vacancy */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            {selectedVacancy ? (
              <div className="adm-card flex flex-col gap-5">
                {/* Vacancy Title Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-gray-900">{selectedVacancy.title}</h2>
                      <span
                        className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                          selectedVacancy.status === 'OPEN'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {selectedVacancy.status}
                      </span>
                    </div>
                    {selectedVacancy.description && (
                      <p className="text-xs text-gray-500 mt-1 max-w-xl">{selectedVacancy.description}</p>
                    )}
                  </div>

                  {canManage && selectedVacancy.status === 'OPEN' && (
                    <button
                      onClick={() => setShowCandidateModal(true)}
                      className="adm-btn adm-btn-primary adm-btn-sm whitespace-nowrap"
                    >
                      <Plus size={14} />
                      <span>Add Candidate</span>
                    </button>
                  )}
                </div>

                {/* Pipeline Stages View */}
                {candidatesLoading ? (
                  <div className="adm-empty flex items-center justify-center gap-2">
                    <Clock size={16} className="animate-spin" />
                    <span>Loading candidate pipeline...</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {STAGES.map((stage) => {
                      const stageCandidates = candidates.filter((c) => c.stage === stage.key);
                      return (
                        <div
                          key={stage.key}
                          className="flex flex-col rounded-xl border border-gray-200 bg-gray-50/60 p-3 min-h-[300px]"
                        >
                          {/* Stage Column Header */}
                          <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-gray-200">
                            <span
                              className="text-xs font-bold px-2 py-0.5 rounded-md"
                              style={{ color: stage.color, backgroundColor: stage.bg }}
                            >
                              {stage.label}
                            </span>
                            <span className="text-xs font-semibold text-gray-500">{stageCandidates.length}</span>
                          </div>

                          {/* Candidate Cards in Stage */}
                          <div className="flex flex-col gap-2.5 overflow-y-auto max-h-[460px] pr-0.5">
                            {stageCandidates.length === 0 ? (
                              <div className="text-center py-8 text-xs text-gray-400 italic">No candidates</div>
                            ) : (
                              stageCandidates.map((candidate) => {
                                const latestOffer = candidate.offers?.[0];
                                return (
                                  <div
                                    key={candidate.id}
                                    className="p-3 bg-white rounded-lg border border-gray-200 shadow-sm flex flex-col gap-2 transition-all hover:border-gray-300"
                                  >
                                    <div className="flex items-start justify-between">
                                      <div className="font-semibold text-sm text-gray-900">
                                        {candidate.firstName} {candidate.lastName}
                                      </div>
                                      {candidate.stage === 'HIRED' && (
                                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                                          Hired
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex flex-col gap-0.5 text-xs text-gray-500">
                                      <span className="flex items-center gap-1 truncate">
                                        <Mail size={11} className="text-gray-400 shrink-0" />
                                        {candidate.email}
                                      </span>
                                      {candidate.phone && (
                                        <span className="flex items-center gap-1">
                                          <Phone size={11} className="text-gray-400 shrink-0" />
                                          {candidate.phone}
                                        </span>
                                      )}
                                    </div>

                                    {/* Offer details if present */}
                                    {latestOffer && (
                                      <div className="mt-1 p-2 rounded bg-teal-50/70 border border-teal-100 text-xs text-teal-900 flex flex-col gap-1">
                                        <div className="flex items-center justify-between font-semibold">
                                          <span>Offer: {latestOffer.status}</span>
                                          {latestOffer.salaryAmount && (
                                            <span>£{Number(latestOffer.salaryAmount).toLocaleString()}</span>
                                          )}
                                        </div>
                                        {latestOffer.status === 'SENT' && canManage && (
                                          <button
                                            onClick={() =>
                                              handleAcceptOffer(
                                                latestOffer.id,
                                                `${candidate.firstName} ${candidate.lastName}`
                                              )
                                            }
                                            disabled={submitting}
                                            className="adm-btn adm-btn-primary adm-btn-sm py-1 text-[11px] justify-center mt-1"
                                          >
                                            <CheckCircle2 size={12} />
                                            <span>Accept & Onboard</span>
                                          </button>
                                        )}
                                      </div>
                                    )}

                                    {/* Action Buttons */}
                                    {canManage && candidate.stage !== 'HIRED' && candidate.stage !== 'REJECTED' && (
                                      <div className="pt-2 border-t border-gray-100 flex items-center gap-1.5 justify-end">
                                        <button
                                          onClick={() => {
                                            setStageCandidate(candidate);
                                            setStageForm({ stage: 'INTERVIEW', note: '' });
                                          }}
                                          title="Advance Stage"
                                          className="text-xs text-gray-600 hover:text-emerald-700 p-1 hover:bg-gray-100 rounded"
                                        >
                                          Advance...
                                        </button>
                                        <button
                                          onClick={() => {
                                            setOfferCandidate(candidate);
                                          }}
                                          title="Extend Offer"
                                          className="text-xs font-semibold text-teal-700 hover:text-teal-900 p-1 hover:bg-teal-50 rounded"
                                        >
                                          + Offer
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="adm-card adm-empty py-16">
                <Briefcase size={36} className="mx-auto text-gray-300 mb-2" />
                <p>Select a job vacancy from the left panel to inspect the active applicant pipeline.</p>
              </div>
            )}
          </div>
        </div>

        {/* Modal 1: Post New Vacancy */}
        {showVacancyModal && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Post New Job Vacancy</h3>
                <button onClick={() => setShowVacancyModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">Create an open vacancy to begin receiving applications.</p>

              <form onSubmit={handleCreateVacancy}>
                <div className="adm-form-group">
                  <label className="adm-label">Job Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Senior Backend Engineer"
                    value={vacancyForm.title}
                    onChange={(e) => setVacancyForm({ ...vacancyForm, title: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 adm-form-group">
                  <div>
                    <label className="adm-label">Department</label>
                    <select
                      value={vacancyForm.departmentId}
                      onChange={(e) => setVacancyForm({ ...vacancyForm, departmentId: e.target.value })}
                      className="adm-select"
                    >
                      <option value="">Select Department...</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="adm-label">Designation</label>
                    <select
                      value={vacancyForm.designationId}
                      onChange={(e) => setVacancyForm({ ...vacancyForm, designationId: e.target.value })}
                      className="adm-select"
                    >
                      <option value="">Select Designation...</option>
                      {designations.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Status</label>
                  <select
                    value={vacancyForm.status}
                    onChange={(e) => setVacancyForm({ ...vacancyForm, status: e.target.value })}
                    className="adm-select"
                  >
                    <option value="OPEN">Open (Accepting applicants)</option>
                    <option value="ON_HOLD">On Hold</option>
                    <option value="CLOSED">Closed</option>
                  </select>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Job Description</label>
                  <textarea
                    rows={4}
                    placeholder="Brief summary of requirements and responsibilities..."
                    value={vacancyForm.description}
                    onChange={(e) => setVacancyForm({ ...vacancyForm, description: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setShowVacancyModal(false)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Creating...' : 'Create Vacancy'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal 2: Add Candidate */}
        {showCandidateModal && selectedVacancy && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Add Candidate to Pipeline</h3>
                <button onClick={() => setShowCandidateModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Adding candidate for: <strong>{selectedVacancy.title}</strong>
              </p>

              <form onSubmit={handleAddCandidate}>
                <div className="grid grid-cols-2 gap-3 adm-form-group">
                  <div>
                    <label className="adm-label">First Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Ada"
                      value={candidateForm.firstName}
                      onChange={(e) => setCandidateForm({ ...candidateForm, firstName: e.target.value })}
                      className="adm-input"
                    />
                  </div>
                  <div>
                    <label className="adm-label">Last Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Lovelace"
                      value={candidateForm.lastName}
                      onChange={(e) => setCandidateForm({ ...candidateForm, lastName: e.target.value })}
                      className="adm-input"
                    />
                  </div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Email Address *</label>
                  <input
                    type="email"
                    required
                    placeholder="e.g. ada@example.com"
                    value={candidateForm.email}
                    onChange={(e) => setCandidateForm({ ...candidateForm, email: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Phone Number</label>
                  <input
                    type="tel"
                    placeholder="+44 20 7946 0950"
                    value={candidateForm.phone}
                    onChange={(e) => setCandidateForm({ ...candidateForm, phone: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setShowCandidateModal(false)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Adding...' : 'Add Candidate'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal 3: Advance Candidate Stage */}
        {stageCandidate && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Update Candidate Stage</h3>
                <button onClick={() => setStageCandidate(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Updating stage for: <strong>{stageCandidate.firstName} {stageCandidate.lastName}</strong>
              </p>

              <form onSubmit={handleUpdateStage}>
                <div className="adm-form-group">
                  <label className="adm-label">Target Stage *</label>
                  <select
                    value={stageForm.stage}
                    onChange={(e) => setStageForm({ ...stageForm, stage: e.target.value as any })}
                    className="adm-select"
                  >
                    <option value="APPLIED">Applied</option>
                    <option value="SCREENING">Screening</option>
                    <option value="INTERVIEW">Interview</option>
                    <option value="OFFER">Offer</option>
                    <option value="HIRED">Hired</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Stage Notes</label>
                  <textarea
                    rows={3}
                    placeholder="Interview feedback or stage change comments..."
                    value={stageForm.note}
                    onChange={(e) => setStageForm({ ...stageForm, note: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setStageCandidate(null)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Updating...' : 'Save Stage'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal 4: Create Offer */}
        {offerCandidate && (
          <div className="adm-modal-backdrop">
            <div className="adm-modal">
              <div className="flex items-center justify-between mb-2">
                <h3>Extend Employment Offer</h3>
                <button onClick={() => setOfferCandidate(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>
              <p className="adm-modal-sub">
                Candidate: <strong>{offerCandidate.firstName} {offerCandidate.lastName}</strong>
              </p>

              <form onSubmit={handleCreateOffer}>
                <div className="grid grid-cols-2 gap-3 adm-form-group">
                  <div>
                    <label className="adm-label">Proposed Start Date *</label>
                    <input
                      type="date"
                      required
                      value={offerForm.startDate}
                      onChange={(e) => setOfferForm({ ...offerForm, startDate: e.target.value })}
                      className="adm-input"
                    />
                  </div>

                  <div>
                    <label className="adm-label">Annual Salary (£)</label>
                    <input
                      type="number"
                      step="1000"
                      value={offerForm.salaryAmount}
                      onChange={(e) => setOfferForm({ ...offerForm, salaryAmount: Number(e.target.value) })}
                      className="adm-input"
                    />
                  </div>
                </div>

                <div className="adm-form-group">
                  <label className="adm-label">Terms & Conditions</label>
                  <textarea
                    rows={3}
                    value={offerForm.terms}
                    onChange={(e) => setOfferForm({ ...offerForm, terms: e.target.value })}
                    className="adm-input"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setOfferCandidate(null)}
                    className="adm-btn adm-btn-ghost"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="adm-btn adm-btn-primary"
                  >
                    {submitting ? 'Sending...' : 'Extend Offer'}
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
