'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  TrendingUp,
  Target,
  Star,
  Award,
  Plus,
  Search,
  X,
  RefreshCw,
  CalendarRange,
  MessageSquareQuote,
  Eye,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { PaginationControls } from '../../../components/ui/pagination';
import { useAuth } from '../../../context/auth-context';
import { SystemRole, ReviewStatus } from '@ems/shared';
import '../../../styles/performance.css';

interface Goal {
  id: string;
  title: string;
  targetDate?: string;
  progress: number;
  status: string;
  category?: string;
}

interface ReviewCycle {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  description?: string;
}

interface Review {
  id: string;
  cycleId?: string;
  cycle?: { title: string };
  employeeId?: string;
  employee?: { firstName: string; lastName: string; employeeNumber?: string };
  reviewerId?: string;
  selfRating?: number;
  selfAchievements?: string;
  selfImprovements?: string;
  managerRating?: number;
  managerFeedback?: string;
  finalScore?: number;
  status: string;
}

interface FeedbackItem {
  id: string;
  comments: string;
  type: string;
  rating?: number;
  createdAt?: string;
  recipient?: { firstName: string; lastName: string };
  giver?: { firstName: string; lastName: string };
}

type Tab = 'goals' | 'cycles' | 'reviews' | 'feedback';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'goals', label: 'Goals & OKRs' },
  { id: 'cycles', label: 'Review Cycles' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'feedback', label: 'Feedback' },
];

/**
 * Performance workspace (Phase 2 item 9): cycles, review forms, feedback.
 * Status workflow DRAFT → SELF_REVIEW_SUBMITTED → MANAGER_REVIEW_SUBMITTED →
 * COMPLETED locks completed reviews: they render read-only and the action
 * buttons are hidden (the API also rejects overwrites — Phase 1 A3).
 */
export default function PerformancePage() {
  const { user, hasRole } = useAuth();
  const isHr = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);
  const isManager = hasRole(SystemRole.MANAGER, SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN);

  const [tab, setTab] = useState<Tab>('goals');

  // Goals
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalTotal, setGoalTotal] = useState(0);
  const [goalPage, setGoalPage] = useState(1);
  const [goalSearch, setGoalSearch] = useState('');
  const [goalStatusFilter, setGoalStatusFilter] = useState<'ALL' | 'IN_PROGRESS' | 'COMPLETED'>('ALL');
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [initialProgress, setInitialProgress] = useState(0);
  const [goalSubmitting, setGoalSubmitting] = useState(false);
  const [goalFormError, setGoalFormError] = useState<string | null>(null);

  // Cycles
  const [cycles, setCycles] = useState<ReviewCycle[]>([]);
  const [cyclesLoading, setCyclesLoading] = useState(false);
  const [cyclesError, setCyclesError] = useState<string | null>(null);
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [cycleTitle, setCycleTitle] = useState('');
  const [cycleStart, setCycleStart] = useState('');
  const [cycleEnd, setCycleEnd] = useState('');
  const [cycleDesc, setCycleDesc] = useState('');
  const [cycleSubmitting, setCycleSubmitting] = useState(false);
  const [cycleFormError, setCycleFormError] = useState<string | null>(null);

  // Reviews
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewTotal, setReviewTotal] = useState(0);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [reviewForm, setReviewForm] = useState<'self' | 'manager' | null>(null);
  const [rfRating, setRfRating] = useState(4);
  const [rfText1, setRfText1] = useState('');
  const [rfText2, setRfText2] = useState('');
  const [rfBusy, setRfBusy] = useState(false);
  const [rfError, setRfError] = useState<string | null>(null);

  // Feedback
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [fbRecipient, setFbRecipient] = useState('');
  const [fbType, setFbType] = useState('PEER');
  const [fbRating, setFbRating] = useState(5);
  const [fbComments, setFbComments] = useState('');
  const [fbBusy, setFbBusy] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const GOAL_PAGE_SIZE = 10;
  const REVIEW_PAGE_SIZE = 10;

  const fetchGoals = useCallback(async (pageToLoad: number) => {
    try {
      const res = await api.getPaginated<Goal>('/goals', {
        params: { page: pageToLoad, limit: GOAL_PAGE_SIZE },
      });
      setGoals(res.items);
      setGoalTotal(res.total);
      setGoalPage(res.page);
    } catch (err: any) {
      setError(err?.message || 'Failed to load goals.');
      setGoals([]);
    }
  }, []);

  const fetchCycles = useCallback(async () => {
    setCyclesLoading(true);
    setCyclesError(null);
    try {
      const res = await api.get<ReviewCycle[] | { items: ReviewCycle[] }>('/performance/cycles');
      setCycles(Array.isArray(res) ? res : res?.items || []);
    } catch (err: any) {
      setCyclesError(err?.message || 'Failed to load review cycles.');
      setCycles([]);
    } finally {
      setCyclesLoading(false);
    }
  }, []);

  const fetchReviews = useCallback(async (pageToLoad: number) => {
    setReviewsLoading(true);
    try {
      const res = await api.getPaginated<Review>('/performance/reviews', {
        params: { page: pageToLoad, limit: REVIEW_PAGE_SIZE },
      });
      setReviews(res.items);
      setReviewTotal(res.total);
      setReviewPage(res.page);
    } catch (err: any) {
      setError(err?.message || 'Failed to load reviews.');
      setReviews([]);
    } finally {
      setReviewsLoading(false);
    }
  }, []);

  const fetchFeedback = useCallback(async () => {
    setFeedbackLoading(true);
    try {
      const res = await api.get<FeedbackItem[] | { items: FeedbackItem[] }>('/feedback');
      setFeedback(Array.isArray(res) ? res : res?.items || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load feedback.');
      setFeedback([]);
    } finally {
      setFeedbackLoading(false);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([fetchGoals(1), fetchCycles(), fetchReviews(1), fetchFeedback()]);
    setLoading(false);
  }, [fetchGoals, fetchCycles, fetchReviews, fetchFeedback]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleCreateGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    setGoalSubmitting(true);
    setGoalFormError(null);
    try {
      await api.post('/goals', {
        title: newGoalTitle,
        targetDate: targetDate || undefined,
        progress: Number(initialProgress),
        status: 'IN_PROGRESS',
      });
      setShowGoalModal(false);
      setNewGoalTitle('');
      setTargetDate('');
      setInitialProgress(0);
      fetchGoals(1);
    } catch (err: any) {
      setGoalFormError(err?.message || 'Failed to save goal.');
    } finally {
      setGoalSubmitting(false);
    }
  };

  const handleCreateCycle = async (e: React.FormEvent) => {
    e.preventDefault();
    setCycleSubmitting(true);
    setCycleFormError(null);
    try {
      await api.post('/performance/cycles', {
        title: cycleTitle,
        startDate: cycleStart,
        endDate: cycleEnd,
        description: cycleDesc || undefined,
      });
      setShowCycleModal(false);
      setCycleTitle('');
      setCycleStart('');
      setCycleEnd('');
      setCycleDesc('');
      fetchCycles();
    } catch (err: any) {
      setCycleFormError(err?.message || 'Failed to create the cycle.');
    } finally {
      setCycleSubmitting(false);
    }
  };

  const openReviewForm = (review: Review, form: 'self' | 'manager') => {
    setSelectedReview(review);
    setReviewForm(form);
    setRfRating(4);
    setRfText1('');
    setRfText2('');
    setRfError(null);
  };

  const submitReviewForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReview || !reviewForm) return;
    setRfBusy(true);
    setRfError(null);
    try {
      if (reviewForm === 'self') {
        await api.patch(`/performance/reviews/${selectedReview.id}/self-review`, {
          selfRating: Number(rfRating),
          selfAchievements: rfText1,
          selfImprovements: rfText2,
        });
      } else {
        await api.patch(`/performance/reviews/${selectedReview.id}/manager-review`, {
          managerRating: Number(rfRating),
          managerFeedback: rfText1,
          finalScore: Number(rfText2) || undefined,
        });
      }
      setReviewForm(null);
      setSelectedReview(null);
      fetchReviews(reviewPage);
    } catch (err: any) {
      setRfError(err?.message || 'Could not submit the review.');
    } finally {
      setRfBusy(false);
    }
  };

  const handleGiveFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    setFbBusy(true);
    setFbError(null);
    try {
      await api.post('/feedback', {
        recipientId: fbRecipient,
        type: fbType,
        rating: Number(fbRating),
        comments: fbComments,
      });
      setShowFeedbackModal(false);
      setFbRecipient('');
      setFbComments('');
      fetchFeedback();
    } catch (err: any) {
      setFbError(err?.message || 'Could not submit feedback.');
    } finally {
      setFbBusy(false);
    }
  };

  const filteredGoals = useMemo(() => {
    return goals.filter((g) => {
      const matchStatus = goalStatusFilter === 'ALL' || g.status === goalStatusFilter;
      const q = goalSearch.toLowerCase().trim();
      const matchSearch =
        !q || g.title.toLowerCase().includes(q) || (g.category && g.category.toLowerCase().includes(q));
      return matchStatus && matchSearch;
    });
  }, [goals, goalStatusFilter, goalSearch]);

  const completedCount = reviews.filter((r) => r.status === ReviewStatus.COMPLETED).length;
  const pendingSelf = reviews.filter(
    (r) => r.status === ReviewStatus.DRAFT && (r.employeeId === user?.employeeId || !r.employeeId),
  ).length;

  const canSelfReview = (r: Review) =>
    r.status === ReviewStatus.DRAFT && (isHr || r.employeeId === user?.employeeId);
  const canManagerReview = (r: Review) =>
    r.status === ReviewStatus.SELF_REVIEW_SUBMITTED && (isManager || isHr);
  const isCompleted = (r: Review) =>
    r.status === ReviewStatus.COMPLETED || r.status === ReviewStatus.ARCHIVED;

  return (
    <DashboardLayout title="Performance & Professional Development">
      <div className="performance-editorial-wrapper">
        <div className="perf-page">
          <header className="perf-header">
            <div className="perf-header-top">
              <div>
                <h1 className="perf-title">Performance & Professional Development</h1>
                <p className="perf-subtitle">
                  Review cycles, self and manager appraisals, OKRs, and continuous feedback.
                </p>
              </div>
              <div className="perf-header-actions">
                <div className="perf-stat-pill">
                  <span>Completed Reviews</span>
                  <span className="count">{error ? '—' : completedCount}</span>
                </div>
                <div className="perf-stat-pill">
                  <span>Awaiting Self-Review</span>
                  <span className="count">{error ? '—' : pendingSelf}</span>
                </div>
              </div>
            </div>

            {error && (
              <div style={{ marginBottom: '16px' }}>
                <ErrorBanner
                  resource="performance data"
                  detail={error}
                  onRetry={fetchAll}
                  retrying={loading}
                />
              </div>
            )}

            {/* Tabs */}
            <div className="perf-tabs" role="tablist" aria-label="Performance sections">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`perf-tab-btn ${tab === t.id ? 'active' : ''}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </header>

          {/* ── GOALS TAB ─────────────────────────────────────────── */}
          {tab === 'goals' && (
            <div className="perf-goals-container" style={{ maxWidth: '860px' }}>
              <div className="perf-goals-header">
                <div className="perf-goals-title">
                  <Target className="w-5 h-5 text-emerald-600" />
                  <span>Key Objectives & Performance Targets</span>
                </div>
                <div className="flex gap-2 items-center">
                  <span className="perf-goals-count">{filteredGoals.length} tracked</span>
                  <button onClick={() => setShowGoalModal(true)} className="perf-btn-primary">
                    <Plus className="w-4 h-4" />
                    <span>Set New Goal / OKR</span>
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                  <Search style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', width: '14px', height: '14px', color: 'var(--perf-text-tertiary)' }} />
                  <input
                    type="text"
                    aria-label="Filter objectives"
                    value={goalSearch}
                    onChange={(e) => setGoalSearch(e.target.value)}
                    placeholder="Filter objectives..."
                    style={{
                      width: '100%',
                      padding: '7px 10px 7px 32px',
                      background: 'var(--perf-surface-muted)',
                      border: '1px solid var(--perf-border-subtle)',
                      borderRadius: 'var(--perf-radius-md)',
                      fontSize: '12px',
                      outline: 'none',
                    }}
                  />
                </div>
                {(['ALL', 'IN_PROGRESS', 'COMPLETED'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setGoalStatusFilter(s)}
                    className={`perf-tab-btn ${goalStatusFilter === s ? 'active' : ''}`}
                  >
                    {s === 'ALL' ? 'All' : s === 'IN_PROGRESS' ? 'Active' : 'Done'}
                  </button>
                ))}
              </div>

              <div className="perf-goals-list">
                {loading ? (
                  <div className="perf-empty"><RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />Loading goals…</div>
                ) : filteredGoals.length === 0 ? (
                  <div className="perf-empty">No objectives match your filters.</div>
                ) : (
                  filteredGoals.map((g) => (
                    <div key={g.id} className="perf-goal-card">
                      <div className="perf-goal-top">
                        <div>
                          <div className="perf-goal-name">{g.title}</div>
                          {g.category && (
                            <span style={{ fontSize: '11px', color: 'var(--perf-text-tertiary)', fontFamily: 'var(--perf-font-mono)' }}>
                              {g.category}
                            </span>
                          )}
                        </div>
                        <span className="perf-goal-percent">{g.progress}%</span>
                      </div>
                      <div className="perf-progress-bar">
                        <div
                          className="perf-progress-fill"
                          style={{
                            width: `${g.progress}%`,
                            background: g.progress === 100 ? 'var(--perf-positive)' : 'var(--perf-accent)',
                          }}
                        />
                      </div>
                      <div className="perf-goal-meta">
                        <span>Target: {g.targetDate?.split('T')[0] || '—'}</span>
                        <span className={`perf-goal-badge ${g.progress === 100 ? 'perf-goal-completed' : 'perf-goal-active'}`}>
                          {g.status ? g.status.replace('_', ' ') : 'IN PROGRESS'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ marginTop: '16px' }}>
                <PaginationControls
                  page={goalPage}
                  limit={GOAL_PAGE_SIZE}
                  total={goalTotal}
                  onPageChange={(p) => fetchGoals(p)}
                />
              </div>
            </div>
          )}

          {/* ── CYCLES TAB ────────────────────────────────────────── */}
          {tab === 'cycles' && (
            <div className="perf-goals-container" style={{ maxWidth: '860px' }}>
              <div className="perf-goals-header">
                <div className="perf-goals-title">
                  <CalendarRange className="w-5 h-5 text-emerald-600" />
                  <span>Review Cycles</span>
                </div>
                {isHr && (
                  <button onClick={() => setShowCycleModal(true)} className="perf-btn-primary">
                    <Plus className="w-4 h-4" />
                    <span>New Cycle</span>
                  </button>
                )}
              </div>

              {cyclesError && (
                <div style={{ marginBottom: '12px' }}>
                  <ErrorBanner resource="review cycles" detail={cyclesError} onRetry={fetchCycles} retrying={cyclesLoading} />
                </div>
              )}

              {cyclesLoading ? (
                <div className="perf-empty"><RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />Loading cycles…</div>
              ) : cycles.length === 0 && !cyclesError ? (
                <div className="perf-empty">
                  No review cycles yet. {isHr ? 'Create the first cycle to start appraisals.' : 'Ask HR to open a review cycle.'}
                </div>
              ) : (
                <div className="perf-goals-list">
                  {cycles.map((c) => (
                    <div key={c.id} className="perf-goal-card">
                      <div className="perf-goal-top">
                        <div>
                          <div className="perf-goal-name">{c.title}</div>
                          <span style={{ fontSize: '11px', color: 'var(--perf-text-tertiary)', fontFamily: 'var(--perf-font-mono)' }}>
                            {c.startDate?.split('T')[0]} → {c.endDate?.split('T')[0]}
                          </span>
                        </div>
                        <span className="perf-goal-badge perf-goal-active">OPEN</span>
                      </div>
                      {c.description && (
                        <p style={{ fontSize: '12.5px', color: 'var(--perf-text-secondary)', marginTop: '8px' }}>
                          {c.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── REVIEWS TAB ───────────────────────────────────────── */}
          {tab === 'reviews' && (
            <div className="perf-goals-container" style={{ maxWidth: '980px' }}>
              <div className="perf-goals-header">
                <div className="perf-goals-title">
                  <Award className="w-5 h-5 text-amber-600" />
                  <span>Performance Reviews</span>
                </div>
                <span className="perf-goals-count">{reviewTotal} reviews</span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--perf-text-tertiary)', marginBottom: '14px' }}>
                Workflow: DRAFT → self review → manager review → COMPLETED. Completed
                reviews are read-only and cannot be overwritten.
              </p>

              {reviewsLoading ? (
                <div className="perf-empty"><RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />Loading reviews…</div>
              ) : reviews.length === 0 ? (
                <div className="perf-empty">No reviews found.</div>
              ) : (
                <div className="perf-goals-list">
                  {reviews.map((r) => (
                    <div key={r.id} className="perf-goal-card">
                      <div className="perf-goal-top">
                        <div>
                          <div className="perf-goal-name">
                            {r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : 'Review'}
                            {r.employee?.employeeNumber && (
                              <span style={{ fontWeight: 400, color: 'var(--perf-text-tertiary)', fontSize: '11px', marginLeft: '8px', fontFamily: 'var(--perf-font-mono)' }}>
                                {r.employee.employeeNumber}
                              </span>
                            )}
                          </div>
                          <span style={{ fontSize: '11px', color: 'var(--perf-text-tertiary)' }}>
                            {r.cycle?.title || 'No cycle'}
                          </span>
                        </div>
                        <span className={`perf-goal-badge ${isCompleted(r) ? 'perf-goal-completed' : 'perf-goal-active'}`}>
                          {r.status?.replace(/_/g, ' ')}
                        </span>
                      </div>

                      <div className="perf-ratings-breakdown" style={{ marginTop: '10px' }}>
                        <div className="perf-rating-row">
                          <span className="perf-rating-label">Self:</span>
                          <span className="perf-rating-val">{r.selfRating != null ? `${r.selfRating} / 5` : '—'}</span>
                        </div>
                        <div className="perf-rating-row">
                          <span className="perf-rating-label">Manager:</span>
                          <span className="perf-rating-val">{r.managerRating != null ? `${r.managerRating} / 5` : '—'}</span>
                        </div>
                        <div className="perf-rating-row">
                          <span className="perf-rating-label">Final:</span>
                          <span className="perf-rating-val">{r.finalScore != null ? `${r.finalScore} / 5` : '—'}</span>
                        </div>
                      </div>

                      <div className="flex gap-2 mt-3 flex-wrap">
                        <button
                          className="perf-btn-secondary"
                          onClick={() => {
                            setSelectedReview(r);
                            setReviewForm(null);
                          }}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>{isCompleted(r) ? 'View (read-only)' : 'View'}</span>
                        </button>
                        {!isCompleted(r) && canSelfReview(r) && r.status === ReviewStatus.DRAFT && (
                          <button className="perf-btn-primary" onClick={() => openReviewForm(r, 'self')}>
                            <Star className="w-3.5 h-3.5" />
                            <span>Submit self review</span>
                          </button>
                        )}
                        {!isCompleted(r) && canManagerReview(r) && (
                          <button className="perf-btn-primary" onClick={() => openReviewForm(r, 'manager')}>
                            <TrendingUp className="w-3.5 h-3.5" />
                            <span>Submit manager review</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: '16px' }}>
                <PaginationControls
                  page={reviewPage}
                  limit={REVIEW_PAGE_SIZE}
                  total={reviewTotal}
                  onPageChange={(p) => fetchReviews(p)}
                />
              </div>
            </div>
          )}

          {/* ── FEEDBACK TAB ──────────────────────────────────────── */}
          {tab === 'feedback' && (
            <div className="perf-goals-container" style={{ maxWidth: '860px' }}>
              <div className="perf-goals-header">
                <div className="perf-goals-title">
                  <MessageSquareQuote className="w-5 h-5 text-emerald-600" />
                  <span>Continuous Feedback</span>
                </div>
                <button onClick={() => setShowFeedbackModal(true)} className="perf-btn-primary">
                  <Plus className="w-4 h-4" />
                  <span>Give Feedback</span>
                </button>
              </div>

              {feedbackLoading ? (
                <div className="perf-empty"><RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />Loading feedback…</div>
              ) : feedback.length === 0 ? (
                <div className="perf-empty">No feedback yet. Be the first to recognize a colleague.</div>
              ) : (
                <div className="perf-goals-list">
                  {feedback.map((f) => (
                    <div key={f.id} className="perf-goal-card">
                      <div className="perf-goal-top">
                        <div>
                          <div className="perf-goal-name">
                            To: {f.recipient ? `${f.recipient.firstName} ${f.recipient.lastName}` : '—'}
                          </div>
                          <span style={{ fontSize: '11px', color: 'var(--perf-text-tertiary)' }}>
                            From: {f.giver ? `${f.giver.firstName} ${f.giver.lastName}` : '—'}
                            {' · '}{f.type}
                            {f.createdAt && ` · ${f.createdAt.split('T')[0]}`}
                          </span>
                        </div>
                        {f.rating != null && (
                          <span className="perf-goal-percent">{f.rating} ★</span>
                        )}
                      </div>
                      <p style={{ fontSize: '13px', color: 'var(--perf-text-secondary)', marginTop: '8px', fontStyle: 'italic' }}>
                        “{f.comments}”
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create Goal Modal */}
      {showGoalModal && (
        <div className="perf-modal-overlay" onClick={() => setShowGoalModal(false)}>
          <div className="perf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="perf-modal-header">
              <h3 className="perf-modal-title">Set Performance Target / OKR</h3>
              <button onClick={() => setShowGoalModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--perf-text-tertiary)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateGoal}>
              <div className="perf-form-group">
                <label htmlFor="goal-title" className="perf-form-label">Objective / Key Result Title</label>
                <input id="goal-title" type="text" required value={newGoalTitle} onChange={(e) => setNewGoalTitle(e.target.value)} placeholder="e.g. Implement dual provider inference resilience" className="perf-form-input" />
              </div>
              <div className="perf-form-group">
                <label htmlFor="goal-target-date" className="perf-form-label">Target Completion Date</label>
                <input id="goal-target-date" type="date" required value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="perf-form-input" style={{ fontFamily: 'var(--perf-font-mono)' }} />
              </div>
              <div className="perf-form-group">
                <label htmlFor="goal-progress" className="perf-form-label">Current Progress ({initialProgress}%)</label>
                <input id="goal-progress" type="range" min="0" max="100" value={initialProgress} onChange={(e) => setInitialProgress(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--perf-accent)' }} />
              </div>
              {goalFormError && (
                <div role="alert" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', color: '#f43f5e', fontSize: '12.5px' }}>
                  {goalFormError}
                </div>
              )}
              <div className="perf-form-actions">
                <button type="button" onClick={() => setShowGoalModal(false)} style={{ padding: '8px 16px', borderRadius: 'var(--perf-radius-md)', border: '1px solid var(--perf-border)', background: 'var(--perf-surface-muted)', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={goalSubmitting} className="perf-btn-primary">
                  {goalSubmitting ? 'Saving...' : 'Save Objective'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Cycle Modal */}
      {showCycleModal && (
        <div className="perf-modal-overlay" onClick={() => setShowCycleModal(false)}>
          <div className="perf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="perf-modal-header">
              <h3 className="perf-modal-title">New Review Cycle</h3>
              <button onClick={() => setShowCycleModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--perf-text-tertiary)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCycle}>
              <div className="perf-form-group">
                <label htmlFor="cycle-title" className="perf-form-label">Cycle title</label>
                <input id="cycle-title" type="text" required maxLength={100} value={cycleTitle} onChange={(e) => setCycleTitle(e.target.value)} placeholder="e.g. Annual Performance Appraisal 2026" className="perf-form-input" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="perf-form-group">
                  <label htmlFor="cycle-start" className="perf-form-label">Start date</label>
                  <input id="cycle-start" type="date" required value={cycleStart} onChange={(e) => setCycleStart(e.target.value)} className="perf-form-input" />
                </div>
                <div className="perf-form-group">
                  <label htmlFor="cycle-end" className="perf-form-label">End date</label>
                  <input id="cycle-end" type="date" required value={cycleEnd} onChange={(e) => setCycleEnd(e.target.value)} className="perf-form-input" />
                </div>
              </div>
              <div className="perf-form-group">
                <label htmlFor="cycle-desc" className="perf-form-label">Description</label>
                <textarea id="cycle-desc" rows={3} maxLength={500} value={cycleDesc} onChange={(e) => setCycleDesc(e.target.value)} className="perf-form-input" placeholder="What this cycle covers" />
              </div>
              {cycleFormError && (
                <div role="alert" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', color: '#f43f5e', fontSize: '12.5px' }}>
                  {cycleFormError}
                </div>
              )}
              <div className="perf-form-actions">
                <button type="button" onClick={() => setShowCycleModal(false)} style={{ padding: '8px 16px', borderRadius: 'var(--perf-radius-md)', border: '1px solid var(--perf-border)', background: 'var(--perf-surface-muted)', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={cycleSubmitting} className="perf-btn-primary">
                  {cycleSubmitting ? 'Creating…' : 'Create cycle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Review detail / review form modal */}
      {selectedReview && (
        <div className="perf-modal-overlay" onClick={() => { setSelectedReview(null); setReviewForm(null); }}>
          <div className="perf-modal" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
            <div className="perf-modal-header">
              <div>
                <h3 className="perf-modal-title">
                  {selectedReview.employee ? `${selectedReview.employee.firstName} ${selectedReview.employee.lastName}` : 'Review'}
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--perf-text-tertiary)' }}>
                  {selectedReview.cycle?.title || 'No cycle'} · {selectedReview.status?.replace(/_/g, ' ')}
                  {isCompleted(selectedReview) && ' · READ-ONLY'}
                </p>
              </div>
              <button onClick={() => { setSelectedReview(null); setReviewForm(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--perf-text-tertiary)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {!reviewForm ? (
              <div className="space-y-4">
                <div className="perf-ratings-breakdown">
                  <div className="perf-rating-row">
                    <span className="perf-rating-label">Self rating:</span>
                    <span className="perf-rating-val">{selectedReview.selfRating != null ? `${selectedReview.selfRating} / 5` : '—'}</span>
                  </div>
                  <div className="perf-rating-row">
                    <span className="perf-rating-label">Manager rating:</span>
                    <span className="perf-rating-val">{selectedReview.managerRating != null ? `${selectedReview.managerRating} / 5` : '—'}</span>
                  </div>
                  <div className="perf-rating-row">
                    <span className="perf-rating-label">Final score:</span>
                    <span className="perf-rating-val">{selectedReview.finalScore != null ? `${selectedReview.finalScore} / 5` : '—'}</span>
                  </div>
                </div>
                {selectedReview.selfAchievements && (
                  <div>
                    <div className="perf-form-label">Self achievements</div>
                    <p style={{ fontSize: '13px', color: 'var(--perf-text-secondary)' }}>{selectedReview.selfAchievements}</p>
                  </div>
                )}
                {selectedReview.selfImprovements && (
                  <div>
                    <div className="perf-form-label">Self improvements</div>
                    <p style={{ fontSize: '13px', color: 'var(--perf-text-secondary)' }}>{selectedReview.selfImprovements}</p>
                  </div>
                )}
                {selectedReview.managerFeedback && (
                  <div className="perf-feedback-quote">“{selectedReview.managerFeedback}”</div>
                )}
                {!isCompleted(selectedReview) && (
                  <div className="flex gap-2">
                    {canSelfReview(selectedReview) && selectedReview.status === ReviewStatus.DRAFT && (
                      <button className="perf-btn-primary" onClick={() => openReviewForm(selectedReview, 'self')}>
                        <Star className="w-3.5 h-3.5" /><span>Submit self review</span>
                      </button>
                    )}
                    {canManagerReview(selectedReview) && (
                      <button className="perf-btn-primary" onClick={() => openReviewForm(selectedReview, 'manager')}>
                        <TrendingUp className="w-3.5 h-3.5" /><span>Submit manager review</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={submitReviewForm}>
                {rfError && (
                  <div role="alert" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', color: '#f43f5e', fontSize: '12.5px' }}>
                    {rfError}
                  </div>
                )}
                <div className="perf-form-group">
                  <label htmlFor="rf-rating" className="perf-form-label">
                    {reviewForm === 'self' ? 'Self rating (1–5)' : 'Manager rating (1–5)'}: {rfRating}
                  </label>
                  <input id="rf-rating" type="range" min="1" max="5" step="0.5" value={rfRating} onChange={(e) => setRfRating(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--perf-accent)' }} />
                </div>
                <div className="perf-form-group">
                  <label htmlFor="rf-text1" className="perf-form-label">
                    {reviewForm === 'self' ? 'Key achievements' : 'Manager feedback'}
                  </label>
                  <textarea id="rf-text1" required rows={4} maxLength={2000} value={rfText1} onChange={(e) => setRfText1(e.target.value)} className="perf-form-input" />
                </div>
                <div className="perf-form-group">
                  <label htmlFor="rf-text2" className="perf-form-label">
                    {reviewForm === 'self' ? 'Areas for improvement' : 'Final score (1–5, optional)'}
                  </label>
                  {reviewForm === 'self' ? (
                    <textarea id="rf-text2" required rows={4} maxLength={2000} value={rfText2} onChange={(e) => setRfText2(e.target.value)} className="perf-form-input" />
                  ) : (
                    <input id="rf-text2" type="number" min="1" max="5" step="0.1" value={rfText2} onChange={(e) => setRfText2(e.target.value)} className="perf-form-input" placeholder="Leave blank to keep the manager rating" />
                  )}
                </div>
                <div className="perf-form-actions">
                  <button type="button" onClick={() => setReviewForm(null)} style={{ padding: '8px 16px', borderRadius: 'var(--perf-radius-md)', border: '1px solid var(--perf-border)', background: 'var(--perf-surface-muted)', cursor: 'pointer' }}>
                    Back
                  </button>
                  <button type="submit" disabled={rfBusy} className="perf-btn-primary">
                    {rfBusy ? 'Submitting…' : 'Submit review'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Give feedback modal */}
      {showFeedbackModal && (
        <div className="perf-modal-overlay" onClick={() => setShowFeedbackModal(false)}>
          <div className="perf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="perf-modal-header">
              <h3 className="perf-modal-title">Give Feedback</h3>
              <button onClick={() => setShowFeedbackModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--perf-text-tertiary)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleGiveFeedback}>
              <div className="perf-form-group">
                <label htmlFor="fb-recipient" className="perf-form-label">Recipient (employee ID)</label>
                <input id="fb-recipient" type="text" required value={fbRecipient} onChange={(e) => setFbRecipient(e.target.value)} placeholder="Paste the employee's ID from the directory" className="perf-form-input" style={{ fontFamily: 'var(--perf-font-mono)' }} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="perf-form-group">
                  <label htmlFor="fb-type" className="perf-form-label">Type</label>
                  <select id="fb-type" value={fbType} onChange={(e) => setFbType(e.target.value)} className="perf-form-input">
                    {['PEER', 'UPWARD', 'DOWNWARD', 'SELF'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="perf-form-group">
                  <label htmlFor="fb-rating" className="perf-form-label">Rating (1–5): {fbRating}</label>
                  <input id="fb-rating" type="range" min="1" max="5" value={fbRating} onChange={(e) => setFbRating(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--perf-accent)' }} />
                </div>
              </div>
              <div className="perf-form-group">
                <label htmlFor="fb-comments" className="perf-form-label">Comments</label>
                <textarea id="fb-comments" required rows={4} maxLength={1000} value={fbComments} onChange={(e) => setFbComments(e.target.value)} className="perf-form-input" placeholder="Specific, constructive, kind" />
              </div>
              {fbError && (
                <div role="alert" style={{ marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.3)', color: '#f43f5e', fontSize: '12.5px' }}>
                  {fbError}
                </div>
              )}
              <div className="perf-form-actions">
                <button type="button" onClick={() => setShowFeedbackModal(false)} style={{ padding: '8px 16px', borderRadius: 'var(--perf-radius-md)', border: '1px solid var(--perf-border)', background: 'var(--perf-surface-muted)', cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={fbBusy} className="perf-btn-primary">
                  {fbBusy ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
