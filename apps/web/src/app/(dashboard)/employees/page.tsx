'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  Users,
  Search,
  Mail,
  Phone,
  Building2,
  Briefcase,
  ChevronRight,
  LayoutGrid,
  List,
  ArrowUpRight,
  Building,
  UserCheck,
  X,
  Plus,
} from 'lucide-react';
import { DashboardLayout } from '../../../components/layout/dashboard-layout';
import { api } from '../../../lib/api-client';
import { useEmployeesPage, employeeKeys, EmployeeListItem } from '../../../lib/queries';
import { SkeletonCardGrid, SkeletonTable } from '../../../components/ui/skeleton';
import { ErrorBanner } from '../../../components/ui/error-banner';
import { PaginationControls } from '../../../components/ui/pagination';
import { useAuth } from '../../../context/auth-context';
import { useQueryClient } from '@tanstack/react-query';
import { SystemRole } from '@ems/shared';
import {
  EmployeeFormModal,
  EMPTY_EMPLOYEE_FORM,
} from '../../../components/employees/employee-form-modal';
import '../../../styles/employees.css';

export default function EmployeesPage() {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const canCreate = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [showCreate, setShowCreate] = useState(false);

  const PAGE_SIZE = 12;

  // Debounce the search input; resetting to page 1 on a new query.
  useEffect(() => {
    const delay = setTimeout(
      () => {
        setDebouncedSearch(search);
        setPage(1);
      },
      search ? 300 : 0,
    );
    return () => clearTimeout(delay);
  }, [search]);

  // Go-live Phase 3 item 7: React Query owns the directory server state.
  // keepPreviousData (in the query) keeps the last page visible while the
  // next page loads; `loading` is only true on the very first fetch.
  const {
    data,
    isPending: loading,
    error: queryError,
    refetch,
  } = useEmployeesPage(page, PAGE_SIZE, debouncedSearch);
  const employees: EmployeeListItem[] = data?.items ?? [];
  const total = data?.total ?? 0;
  // No demo fallback: a failed API call shows a loud error, not fabricated staff.
  const error = queryError ? (queryError as Error).message || 'Failed to load employees.' : null;

  // Derived departments list
  const departments = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => {
      if (e.department?.name) set.add(e.department.name);
    });
    return Array.from(set);
  }, [employees]);

  // Filtered employees
  const filteredEmployees = useMemo(() => {
    return employees.filter((emp) => {
      const matchDept = selectedDept === 'ALL' || emp.department?.name === selectedDept;
      const matchStatus = selectedStatus === 'ALL' || emp.status?.toUpperCase() === selectedStatus;
      return matchDept && matchStatus;
    });
  }, [employees, selectedDept, selectedStatus]);

  // Status badge formatter
  const getBadgeClass = (status: string = '') => {
    const s = status.toUpperCase();
    if (s.includes('FULL') || s === 'ACTIVE') return 'emp-badge-full_time';
    if (s.includes('PROB') || s.includes('CONTRACT')) return 'emp-badge-probationary';
    if (s.includes('REMOTE') || s.includes('PART')) return 'emp-badge-remote';
    if (s.includes('LEAVE') || s.includes('PENDING')) return 'emp-badge-leave';
    return 'emp-badge-inactive';
  };

  return (
    <DashboardLayout title="Employees Directory">
      <div className="employees-editorial-wrapper">
        <div className="emp-page">
          {/* Header Section */}
          <header className="emp-header">
            <div className="emp-header-top">
              <div>
                <h1 className="emp-title">Employees Directory</h1>
                <p className="emp-subtitle">
                  Workforce telemetry, departmental rosters, and verified personnel credentials across Neoteric Digital.
                </p>
              </div>

              <div className="emp-header-actions">
                <div className="emp-stat-pill">
                  <span>Total Personnel</span>
                  <span className="count">{error ? '—' : total}</span>
                </div>
                {canCreate && (
                  <button onClick={() => setShowCreate(true)} className="emp-btn-primary">
                    <Plus className="w-4 h-4" />
                    <span>New Employee</span>
                  </button>
                )}
              </div>
            </div>

            {/* ErrorBanner appears under the header when the API fails */}
          {error && (
            <ErrorBanner
              resource="employees"
              detail={error}
              onRetry={() => refetch()}
              retrying={loading}
            />
          )}

          {/* Quick Metrics Row — computed from real API data only */}
          <div className="emp-quick-stats">
            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Total Headcount</div>
                <div className="emp-quick-stat-value">{error ? '—' : total}</div>
              </div>
              <div className="emp-quick-stat-icon">
                <Users className="w-5 h-5" />
              </div>
            </div>

            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Departments</div>
                <div className="emp-quick-stat-value">{error ? '—' : departments.length}</div>
              </div>
              <div className="emp-quick-stat-icon">
                <Building className="w-5 h-5" />
              </div>
            </div>

            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Current View</div>
                <div className="emp-quick-stat-value">{error ? '—' : filteredEmployees.length}</div>
              </div>
              <div className="emp-quick-stat-icon">
                <UserCheck className="w-5 h-5" />
              </div>
            </div>
          </div>
          </header>

          {/* Search, Filters & View Toggle Toolbar */}
          <div className="emp-toolbar">
            <div className="emp-toolbar-row">
              {/* Search Box */}
              <div className="emp-search-container">
                <Search className="emp-search-icon" />
                <input
                  type="text"
                  id="employees-search"
                  aria-label="Search employees"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, email, or employee ID..."
                  className="emp-search-input"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    style={{
                      position: 'absolute',
                      right: '10px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--emp-text-tertiary)',
                    }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* View Switcher */}
              <div className="emp-view-toggle" role="group" aria-label="Directory view">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`emp-view-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  title="Card Grid"
                  aria-label="Card grid view"
                  aria-pressed={viewMode === 'grid'}
                >
                  <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Cards</span>
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`emp-view-btn ${viewMode === 'table' ? 'active' : ''}`}
                  title="Table View"
                  aria-label="Table view"
                  aria-pressed={viewMode === 'table'}
                >
                  <List className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Table</span>
                </button>
              </div>
            </div>

            {/* Department Filter Pills */}
            <div className="emp-filter-pills">
              <button
                onClick={() => setSelectedDept('ALL')}
                className={`emp-filter-pill ${selectedDept === 'ALL' ? 'active' : ''}`}
              >
                All Departments ({employees.length})
              </button>
              {departments.map((dept) => {
                const count = employees.filter((e) => e.department?.name === dept).length;
                return (
                  <button
                    key={dept}
                    onClick={() => setSelectedDept(dept)}
                    className={`emp-filter-pill ${selectedDept === dept ? 'active' : ''}`}
                  >
                    {dept} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Directory Content — polite live region: announced once per update */}
          <div aria-live="polite" aria-label="Employees directory results">
          {loading ? (
            viewMode === 'table' ? (
              <SkeletonTable rows={8} columns={6} />
            ) : (
              <SkeletonCardGrid cards={8} />
            )
          ) : filteredEmployees.length === 0 ? (
            <div className="emp-empty-state">
              <div className="emp-empty-icon">
                <Users className="w-6 h-6" />
              </div>
              <h3 className="emp-empty-title">No Personnel Records Found</h3>
              <p className="emp-empty-desc">
                No active employee records match your search criteria or filter configuration.
              </p>
              {(search || selectedDept !== 'ALL') && (
                <button
                  onClick={() => {
                    setSearch('');
                    setSelectedDept('ALL');
                  }}
                  className="emp-btn-primary"
                  style={{ display: 'inline-flex' }}
                >
                  Reset Query
                </button>
              )}
            </div>
          ) : viewMode === 'grid' ? (
            /* Card Grid Layout */
            <div className="emp-grid">
              {filteredEmployees.map((emp) => (
                <div key={emp.id} className="emp-card">
                  <div>
                    <div className="emp-card-header">
                      <div className="emp-avatar-wrapper">
                        {emp.avatarUrl ? (
                          <img
                            src={emp.avatarUrl}
                            alt={`${emp.firstName} ${emp.lastName}`}
                            className="emp-avatar-img"
                          />
                        ) : (
                          <div className="emp-avatar-fallback">
                            {emp.firstName?.[0] || 'E'}
                            {emp.lastName?.[0] || ''}
                          </div>
                        )}
                      </div>
                      <span className={`emp-badge ${getBadgeClass(emp.status)}`}>
                        {emp.status ? emp.status.replace('_', ' ') : '—'}
                      </span>
                    </div>

                    <div className="emp-card-name">
                      {emp.firstName} {emp.lastName}
                    </div>
                    <div className="emp-card-code">{emp.employeeNumber}</div>

                    <div className="emp-card-details">
                      <div className="emp-detail-row">
                        <Briefcase />
                        <span className="emp-detail-text" style={{ fontWeight: 500, color: 'var(--emp-text-primary)' }}>
                          {emp.designation?.title || '—'}
                        </span>
                      </div>
                      <div className="emp-detail-row">
                        <Building2 />
                        <span className="emp-detail-text">
                          {emp.department?.name || '—'}
                        </span>
                      </div>
                      <div className="emp-detail-row">
                        <Mail />
                        <span className="emp-detail-text emp-detail-email">{emp.email}</span>
                      </div>
                      {emp.phone && (
                        <div className="emp-detail-row">
                          <Phone />
                          <span className="emp-detail-text emp-detail-email">{emp.phone}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="emp-card-footer">
                    <Link href={`/employees/${emp.id}`} className="emp-profile-link">
                      <span>View Full Profile</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Editorial Table Layout */
            <div className="emp-table-wrapper">
              <table className="emp-table">
                <thead>
                  <tr>
                    <th>Personnel</th>
                    <th>Employee Code</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map((emp) => (
                    <tr key={emp.id}>
                      <td>
                        <div className="emp-table-user">
                          {emp.avatarUrl ? (
                            <img
                              src={emp.avatarUrl}
                              alt=""
                              className="emp-table-avatar"
                            />
                          ) : (
                            <div className="emp-table-avatar-fallback">
                              {emp.firstName?.[0] || 'E'}
                              {emp.lastName?.[0] || ''}
                            </div>
                          )}
                          <div>
                            <div className="emp-table-name">
                              {emp.firstName} {emp.lastName}
                            </div>
                            <div className="emp-table-email">{emp.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="emp-table-code">{emp.employeeNumber}</span>
                      </td>
                      <td>{emp.department?.name || '—'}</td>
                      <td style={{ fontWeight: 500, color: 'var(--emp-text-primary)' }}>
                        {emp.designation?.title || '—'}
                      </td>
                      <td>
                        <span className={`emp-badge ${getBadgeClass(emp.status)}`}>
                          {emp.status ? emp.status.replace('_', ' ') : '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Link href={`/employees/${emp.id}`} className="emp-table-action">
                          <span>Profile</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>

          {/* Pagination — wired to ?page&limit and the API's {items,total} response */}
          <div style={{ marginTop: '20px' }}>
            <PaginationControls
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </div>

          <EmployeeFormModal
            open={showCreate}
            mode="create"
            initial={EMPTY_EMPLOYEE_FORM}
            onClose={() => setShowCreate(false)}
            onSubmit={async (payload) => {
              await api.post('/employees', payload);
              setPage(1);
              // Drop all cached directory pages so the new hire appears
              // without a stale page hanging around.
              await queryClient.invalidateQueries({ queryKey: employeeKeys.all });
            }}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
