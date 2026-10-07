'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
  Check,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useAuth } from '../../../context/auth-context';
import { SystemRole } from '@ems/shared';
import '../../../styles/editorial-common.css';

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

const STAGES: Array<{ key: Candidate['stage']; label: string; badgeClass: string }> = [
  { key: 'APPLIED', label: 'Applied', badgeClass: 'editorial-badge-info' },
  { key: 'SCREENING', label: 'Screening', badgeClass: 'editorial-badge-purple' },
  { key: 'INTERVIEW', label: 'Interview', badgeClass: 'editorial-badge-warning' },
  { key: 'OFFER', label: 'Offer Sent', badgeClass: 'editorial-badge-positive' },
  { key: 'HIRED', label: 'Hired', badgeClass: 'editorial-badge-success' },
  { key: 'REJECTED', label: 'Archived', badgeClass: 'editorial-badge-neutral' },
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
    terms: 'Full-time permanent employment with standard enterprise benefits package.',
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
    } catch {
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
    if (
      !confirm(
        `Confirm acceptance of offer for ${candidateName}? This will automatically generate a new Employee record in the directory.`,
      )
    ) {
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

  const filteredVacancies = useMemo(() => {
    return vacancies.filter((v) => {
      const matchesStatus = statusFilter === 'ALL' || v.status === statusFilter;
      const matchesSearch =
        v.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (v.description && v.description.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesStatus && matchesSearch;
    });
  }, [vacancies, statusFilter, searchQuery]);

  const totalOpenRoles = useMemo(
    () => vacancies.filter((v) => v.status === 'OPEN').length,
    [vacancies],
  );
  const totalApplicants = useMemo(
    () => vacancies.reduce((acc, v) => acc + (v._count?.candidates || 0), 0),
    [vacancies],
  );

  return (
    <DashboardLayout title="Recruitment & Talent Pipeline">
      <div className="editorial-wrapper">
        <div className="editorial-page">
          {/* Page Header */}
          <header className="editorial-header">
            <div className="editorial-header-top">
              <div>
                <h1 className="editorial-title">Recruitment & Talent Pipeline</h1>
                <p className="editorial-subtitle">
                  Workforce requisitions, applicant evaluation stages, formal offers, and automated personnel directory onboarding.
                </p>
              </div>

              <div className="editorial-header-actions">
                <div className="editorial-stat-pill">
                  <Briefcase size={14} style={{ color: 'var(--edit-accent)' }} />
                  <span>Open Positions:</span>
                  <span className="count">{totalOpenRoles}</span>
                </div>
                <div className="editorial-stat-pill">
                  <Users size={14} />
                  <span>Total Applicants:</span>
                  <span className="count">{totalApplicants}</span>
                </div>
                {canManage && (
                  <button
                    onClick={() => setShowVacancyModal(true)}
                    className="editorial-btn-primary"
                  >
                    <Plus size={15} />
                    <span>Post New Vacancy</span>
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
                <div className="editorial-quick-stat-label">Total Requisitions</div>
                <div className="editorial-quick-stat-value">{vacancies.length}</div>
                <div className="editorial-quick-stat-sub">Across all departments</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Briefcase size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Open Vacancies</div>
                <div className="editorial-quick-stat-value">{totalOpenRoles}</div>
                <div className="editorial-quick-stat-sub">Active talent searches</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Sparkles size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Total Applicants</div>
                <div className="editorial-quick-stat-value">{totalApplicants}</div>
                <div className="editorial-quick-stat-sub">Received across postings</div>
              </div>
              <div className="editorial-quick-stat-icon">
                <Users size={18} />
              </div>
            </div>

            <div className="editorial-quick-stat-card">
              <div>
                <div className="editorial-quick-stat-label">Selected Role Pipeline</div>
                <div className="editorial-quick-stat-value">{candidates.length}</div>
                <div className="editorial-quick-stat-sub">
                  {selectedVacancy?.title ? selectedVacancy.title.slice(0, 22) : 'No role selected'}
                </div>
              </div>
              <div className="editorial-quick-stat-icon">
                <FileCheck size={18} />
              </div>
            </div>
          </div>

          {/* Two-Column Editorial Explorer Layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', alignItems: 'start' }}>
            {/* Left Column: Job Openings List */}
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
                  Job Openings
                </h2>
                <span className="editorial-stat-pill" style={{ padding: '2px 8px', fontSize: '11px' }}>
                  {filteredVacancies.length} roles
                </span>
              </div>

              {/* Search & Filter pills */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="editorial-search-container" style={{ maxWidth: '100%' }}>
                  <Search className="editorial-search-icon" />
                  <input
                    type="text"
                    placeholder="Filter openings..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="editorial-search-input"
                    style={{ fontSize: '12px', padding: '6px 10px 6px 32px' }}
                  />
                </div>

                <div className="editorial-filter-pills" style={{ gap: '4px' }}>
                  {(['ALL', 'OPEN', 'ON_HOLD', 'CLOSED'] as const).map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatusFilter(st)}
                      className={`editorial-filter-pill ${statusFilter === st ? 'active' : ''}`}
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      {st === 'ALL' ? 'All' : st.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vacancies cards list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '560px', overflowY: 'auto' }}>
                {filteredVacancies.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--edit-text-tertiary)', fontSize: '12.5px' }}>
                    No job openings match filter.
                  </div>
                ) : (
                  filteredVacancies.map((vac) => {
                    const isSelected = selectedVacancy?.id === vac.id;
                    const dept = departments.find((d) => d.id === vac.departmentId);
                    return (
                      <div
                        key={vac.id}
                        onClick={() => setSelectedVacancy(vac)}
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
                            {vac.title}
                          </div>
                          <span
                            className={`editorial-badge ${
                              vac.status === 'OPEN'
                                ? 'editorial-badge-positive'
                                : vac.status === 'ON_HOLD'
                                ? 'editorial-badge-warning'
                                : 'editorial-badge-neutral'
                            }`}
                            style={{ fontSize: '10px', padding: '1px 6px' }}
                          >
                            {vac.status}
                          </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px', fontSize: '11.5px', color: 'var(--edit-text-secondary)' }}>
                          <span>{dept?.name || 'General Org'}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--edit-font-mono)' }}>
                            <Users size={12} />
                            {vac._count?.candidates ?? 0}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Column: Selected Vacancy Pipeline Board */}
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
              {selectedVacancy ? (
                <>
                  {/* Selected Vacancy Header */}
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
                          {selectedVacancy.title}
                        </h2>
                        <span
                          className={`editorial-badge ${
                            selectedVacancy.status === 'OPEN'
                              ? 'editorial-badge-positive'
                              : 'editorial-badge-neutral'
                          }`}
                        >
                          {selectedVacancy.status}
                        </span>
                      </div>
                      {selectedVacancy.description && (
                        <p style={{ fontSize: '13px', color: 'var(--edit-text-secondary)', margin: '4px 0 0', maxWidth: '640px' }}>
                          {selectedVacancy.description}
                        </p>
                      )}
                    </div>

                    {canManage && selectedVacancy.status === 'OPEN' && (
                      <button
                        onClick={() => setShowCandidateModal(true)}
                        className="editorial-btn-primary"
                        style={{ padding: '6px 14px', fontSize: '12.5px' }}
                      >
                        <Plus size={14} />
                        <span>Add Candidate</span>
                      </button>
                    )}
                  </div>

                  {/* Kanban Pipeline Board */}
                  {candidatesLoading ? (
                    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                      <Clock size={20} className="animate-spin" style={{ margin: '0 auto 8px', color: 'var(--edit-accent)' }} />
                      <p style={{ margin: 0, fontSize: '13px' }}>Loading candidate pipeline stages...</p>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '14px',
                        overflowX: 'auto',
                      }}
                    >
                      {STAGES.map((stage) => {
                        const stageCandidates = candidates.filter((c) => c.stage === stage.key);
                        return (
                          <div
                            key={stage.key}
                            style={{
                              background: 'var(--edit-surface-muted)',
                              border: '1px solid var(--edit-border-subtle)',
                              borderRadius: 'var(--edit-radius-md)',
                              padding: '12px',
                              display: 'flex',
                              flexDirection: 'column',
                              minHeight: '380px',
                            }}
                          >
                            {/* Column Header */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                borderBottom: '1px solid var(--edit-border-subtle)',
                                paddingBottom: '8px',
                                marginBottom: '10px',
                              }}
                            >
                              <span className={`editorial-badge ${stage.badgeClass}`}>
                                {stage.label}
                              </span>
                              <span
                                className="editorial-mono"
                                style={{ fontSize: '11px', fontWeight: 600, color: 'var(--edit-text-tertiary)' }}
                              >
                                {stageCandidates.length}
                              </span>
                            </div>

                            {/* Candidate Cards */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, overflowY: 'auto' }}>
                              {stageCandidates.length === 0 ? (
                                <div
                                  style={{
                                    textAlign: 'center',
                                    padding: '30px 10px',
                                    fontSize: '11.5px',
                                    color: 'var(--edit-text-tertiary)',
                                    fontStyle: 'italic',
                                  }}
                                >
                                  No candidates
                                </div>
                              ) : (
                                stageCandidates.map((candidate) => {
                                  const latestOffer = candidate.offers?.[0];
                                  return (
                                    <div
                                      key={candidate.id}
                                      style={{
                                        background: 'var(--edit-surface)',
                                        border: '1px solid var(--edit-border)',
                                        borderRadius: 'var(--edit-radius-sm)',
                                        padding: '10px 12px',
                                        boxShadow: 'var(--edit-shadow-sm)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '6px',
                                      }}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                                        <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--edit-text-primary)' }}>
                                          {candidate.firstName} {candidate.lastName}
                                        </div>
                                        {candidate.stage === 'HIRED' && (
                                          <span className="editorial-badge editorial-badge-success" style={{ fontSize: '9px', padding: '1px 5px' }}>
                                            Hired
                                          </span>
                                        )}
                                      </div>

                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: 'var(--edit-text-secondary)' }}>
                                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                                          <Mail size={11} style={{ color: 'var(--edit-text-tertiary)', flexShrink: 0 }} />
                                          <span className="editorial-mono">{candidate.email}</span>
                                        </span>
                                        {candidate.phone && (
                                          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                            <Phone size={11} style={{ color: 'var(--edit-text-tertiary)', flexShrink: 0 }} />
                                            <span className="editorial-mono">{candidate.phone}</span>
                                          </span>
                                        )}
                                      </div>

                                      {/* Offer details if present */}
                                      {latestOffer && (
                                        <div
                                          style={{
                                            padding: '8px',
                                            borderRadius: 'var(--edit-radius-sm)',
                                            background: 'var(--edit-accent-light)',
                                            border: '1px solid var(--edit-accent-muted)',
                                            fontSize: '11px',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '4px',
                                          }}
                                        >
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600 }}>
                                            <span>Offer: {latestOffer.status}</span>
                                            {latestOffer.salaryAmount && (
                                              <span className="editorial-mono">£{Number(latestOffer.salaryAmount).toLocaleString()}</span>
                                            )}
                                          </div>
                                          {latestOffer.status === 'SENT' && canManage && (
                                            <button
                                              onClick={() =>
                                                handleAcceptOffer(
                                                  latestOffer.id,
                                                  `${candidate.firstName} ${candidate.lastName}`,
                                                )
                                              }
                                              className="editorial-btn-primary"
                                              style={{ fontSize: '10px', padding: '3px 8px', width: '100%', justifyContent: 'center' }}
                                            >
                                              <Check size={11} />
                                              <span>Accept & Create Employee</span>
                                            </button>
                                          )}
                                        </div>
                                      )}

                                      {/* Candidate action footer */}
                                      {canManage && (
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px', paddingTop: '6px', borderTop: '1px solid var(--edit-border-subtle)' }}>
                                          <button
                                            onClick={() => {
                                              setStageCandidate(candidate);
                                              setStageForm({ stage: candidate.stage, note: '' });
                                            }}
                                            className="editorial-btn-ghost"
                                            style={{ fontSize: '11px', padding: '2px 6px', color: 'var(--edit-accent)', fontWeight: 600 }}
                                          >
                                            Advance Stage →
                                          </button>

                                          {!latestOffer && candidate.stage === 'INTERVIEW' && (
                                            <button
                                              onClick={() => {
                                                setOfferCandidate(candidate);
                                                setOfferForm({
                                                  startDate: new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
                                                  salaryAmount: 65000,
                                                  terms: 'Full-time permanent employment with standard enterprise benefits package.',
                                                });
                                              }}
                                              className="editorial-btn-ghost"
                                              style={{ fontSize: '11px', padding: '2px 6px', color: 'var(--edit-positive)', fontWeight: 600 }}
                                            >
                                              Extend Offer
                                            </button>
                                          )}
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
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--edit-text-secondary)' }}>
                  <Briefcase size={36} style={{ margin: '0 auto 12px', color: 'var(--edit-text-tertiary)' }} />
                  <div style={{ fontFamily: 'var(--edit-font-serif)', fontSize: '20px', color: 'var(--edit-text-primary)' }}>
                    No job vacancy selected
                  </div>
                  <p style={{ fontSize: '13px', marginTop: '4px' }}>
                    Select an opening from the left panel to review its active candidate pipeline and stage progressions.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Modal 1: Post New Vacancy */}
          {showVacancyModal && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Post New Job Vacancy</h3>
                    <p className="editorial-modal-subtitle">Create a formal recruitment requisition for departmental talent search.</p>
                  </div>
                  <button onClick={() => setShowVacancyModal(false)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleCreateVacancy}>
                  <div className="editorial-modal-body">
                    <div className="editorial-form-group">
                      <label className="editorial-label">Job Title *</label>
                      <input
                        required
                        type="text"
                        placeholder="e.g. Senior Full-Stack Engineer"
                        value={vacancyForm.title}
                        onChange={(e) => setVacancyForm({ ...vacancyForm, title: e.target.value })}
                        className="editorial-input"
                      />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                      <div className="editorial-form-group">
                        <label className="editorial-label">Department</label>
                        <select
                          value={vacancyForm.departmentId}
                          onChange={(e) => setVacancyForm({ ...vacancyForm, departmentId: e.target.value })}
                          className="editorial-select"
                        >
                          <option value="">Select Department...</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>{d.name} ({d.code})</option>
                          ))}
                        </select>
                      </div>

                      <div className="editorial-form-group">
                        <label className="editorial-label">Job Designation</label>
                        <select
                          value={vacancyForm.designationId}
                          onChange={(e) => setVacancyForm({ ...vacancyForm, designationId: e.target.value })}
                          className="editorial-select"
                        >
                          <option value="">Select Level/Title...</option>
                          {designations.map((d) => (
                            <option key={d.id} value={d.id}>{d.title}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Requisition Status</label>
                      <select
                        value={vacancyForm.status}
                        onChange={(e) => setVacancyForm({ ...vacancyForm, status: e.target.value as any })}
                        className="editorial-select"
                      >
                        <option value="OPEN">Open (Accepting Applicants)</option>
                        <option value="ON_HOLD">On Hold</option>
                        <option value="CLOSED">Closed</option>
                      </select>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Role Description & Competencies</label>
                      <textarea
                        rows={3}
                        placeholder="Brief overview of job responsibilities and requirements..."
                        value={vacancyForm.description}
                        onChange={(e) => setVacancyForm({ ...vacancyForm, description: e.target.value })}
                        className="editorial-textarea"
                      />
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setShowVacancyModal(false)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting} className="editorial-btn-primary">
                      {submitting ? 'Creating...' : 'Publish Vacancy'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal 2: Add Candidate */}
          {showCandidateModal && selectedVacancy && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Add Candidate to Pipeline</h3>
                    <p className="editorial-modal-subtitle">Enroll applicant for: {selectedVacancy.title}</p>
                  </div>
                  <button onClick={() => setShowCandidateModal(false)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleAddCandidate}>
                  <div className="editorial-modal-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                      <div className="editorial-form-group">
                        <label className="editorial-label">First Name *</label>
                        <input
                          required
                          type="text"
                          value={candidateForm.firstName}
                          onChange={(e) => setCandidateForm({ ...candidateForm, firstName: e.target.value })}
                          className="editorial-input"
                        />
                      </div>
                      <div className="editorial-form-group">
                        <label className="editorial-label">Last Name *</label>
                        <input
                          required
                          type="text"
                          value={candidateForm.lastName}
                          onChange={(e) => setCandidateForm({ ...candidateForm, lastName: e.target.value })}
                          className="editorial-input"
                        />
                      </div>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Email Address *</label>
                      <input
                        required
                        type="email"
                        placeholder="candidate@domain.com"
                        value={candidateForm.email}
                        onChange={(e) => setCandidateForm({ ...candidateForm, email: e.target.value })}
                        className="editorial-input"
                      />
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Phone Contact (Optional)</label>
                      <input
                        type="tel"
                        placeholder="+44 7700 900000"
                        value={candidateForm.phone}
                        onChange={(e) => setCandidateForm({ ...candidateForm, phone: e.target.value })}
                        className="editorial-input"
                      />
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setShowCandidateModal(false)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting} className="editorial-btn-primary">
                      {submitting ? 'Adding...' : 'Add to Pipeline'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal 3: Update Candidate Stage */}
          {stageCandidate && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Advance Candidate Stage</h3>
                    <p className="editorial-modal-subtitle">
                      Candidate: {stageCandidate.firstName} {stageCandidate.lastName}
                    </p>
                  </div>
                  <button onClick={() => setStageCandidate(null)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleUpdateStage}>
                  <div className="editorial-modal-body">
                    <div className="editorial-form-group">
                      <label className="editorial-label">Target Stage *</label>
                      <select
                        value={stageForm.stage}
                        onChange={(e) => setStageForm({ ...stageForm, stage: e.target.value as any })}
                        className="editorial-select"
                      >
                        {STAGES.map((s) => (
                          <option key={s.key} value={s.key}>{s.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Interview or Evaluation Notes (Optional)</label>
                      <textarea
                        rows={3}
                        placeholder="Feedback from interview panel, score, or recommendation..."
                        value={stageForm.note}
                        onChange={(e) => setStageForm({ ...stageForm, note: e.target.value })}
                        className="editorial-textarea"
                      />
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setStageCandidate(null)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting} className="editorial-btn-primary">
                      {submitting ? 'Updating...' : 'Confirm Stage Progression'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal 4: Extend Job Offer */}
          {offerCandidate && (
            <div className="editorial-modal-overlay">
              <div className="editorial-modal">
                <div className="editorial-modal-header">
                  <div>
                    <h3 className="editorial-modal-title">Extend Formal Job Offer</h3>
                    <p className="editorial-modal-subtitle">
                      Candidate: {offerCandidate.firstName} {offerCandidate.lastName}
                    </p>
                  </div>
                  <button onClick={() => setOfferCandidate(null)} className="editorial-modal-close">
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleCreateOffer}>
                  <div className="editorial-modal-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                      <div className="editorial-form-group">
                        <label className="editorial-label">Anticipated Start Date *</label>
                        <input
                          required
                          type="date"
                          value={offerForm.startDate}
                          onChange={(e) => setOfferForm({ ...offerForm, startDate: e.target.value })}
                          className="editorial-input"
                        />
                      </div>
                      <div className="editorial-form-group">
                        <label className="editorial-label">Annual Base Salary (£) *</label>
                        <input
                          required
                          type="number"
                          step="1000"
                          value={offerForm.salaryAmount}
                          onChange={(e) => setOfferForm({ ...offerForm, salaryAmount: Number(e.target.value) })}
                          className="editorial-input editorial-mono"
                        />
                      </div>
                    </div>

                    <div className="editorial-form-group">
                      <label className="editorial-label">Offer Terms & Compensation Structure</label>
                      <textarea
                        rows={3}
                        value={offerForm.terms}
                        onChange={(e) => setOfferForm({ ...offerForm, terms: e.target.value })}
                        className="editorial-textarea"
                      />
                    </div>
                  </div>

                  <div className="editorial-modal-footer">
                    <button type="button" onClick={() => setOfferCandidate(null)} className="editorial-btn-secondary">
                      Cancel
                    </button>
                    <button type="submit" disabled={submitting} className="editorial-btn-primary">
                      {submitting ? 'Dispatching...' : 'Dispatch Formal Offer'}
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
