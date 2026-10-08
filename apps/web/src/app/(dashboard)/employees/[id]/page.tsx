'use client';

import React, { useState, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Briefcase,
  UserCheck,
  Banknote,
  CalendarDays,
  Camera,
  Pencil,
  MapPin,
  Phone,
  Mail,
  FileSignature,
  PhoneCall,
  ShieldCheck,
  Award,
  Users,
  CheckCircle2,
  Calendar,
  ChevronRight,
  ExternalLink,
  Clock,
  HeartHandshake,
  Hash,
  Sparkles,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import { useAuth } from '../../../../context/auth-context';
import { formatCurrency } from '../../../../lib/date-utils';
import { employeeToForm } from '../../../../components/employees/employee-form-modal';
import { SystemRole } from '@ems/shared';
import { useEmployeeDetailQuery, employeeKeys } from '../../../../lib/queries';
import '../../../../styles/employees.css';

const AvatarModal = dynamic(
  () => import('../../../../components/profile/avatar-modal').then((mod) => mod.AvatarModal),
  { ssr: false },
);

const EmployeeFormModal = dynamic(
  () => import('../../../../components/employees/employee-form-modal').then((mod) => mod.EmployeeFormModal),
  { ssr: false },
);

type ProfileTab = 'overview' | 'employment' | 'compensation' | 'leaves' | 'team' | 'emergency';

export default function EmployeeDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const { user, hasRole } = useAuth();
  const queryClient = useQueryClient();
  const { data: employee, isPending: loading, error: queryError, refetch } = useEmployeeDetailQuery(id);
  const error = queryError ? (queryError as Error).message || 'Failed to load this employee profile.' : null;
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>('overview');

  const canEdit =
    hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN) ||
    user?.employeeId === employee?.id ||
    user?.email === employee?.email;

  // Tenure calculation helper
  const tenureText = useMemo(() => {
    if (!employee?.joiningDate) return '—';
    const start = new Date(employee.joiningDate);
    const now = new Date();
    const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if (months < 1) return 'New Joiner';
    if (months < 12) return `${months} ${months === 1 ? 'Month' : 'Months'}`;
    const years = (months / 12).toFixed(1);
    return `${years} Years`;
  }, [employee?.joiningDate]);

  // Leave aggregates
  const totalRemainingLeave = useMemo(() => {
    if (!employee?.leaveBalances?.length) return 0;
    return employee.leaveBalances.reduce((acc: number, lb: any) => acc + (lb.remainingDays || 0), 0);
  }, [employee?.leaveBalances]);

  const activeSalaryStructure = employee?.salaryStructures?.[0];
  const baseSalary = activeSalaryStructure?.baseSalary;

  if (loading) {
    return (
      <DashboardLayout title="Employee Profile">
        <div className="employees-editorial-wrapper">
          <div className="emp-page">
            <div className="emp-loading-state">
              <div className="emp-spinner" />
              <span>Retrieving verified employee dossier...</span>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (error || !employee) {
    return (
      <DashboardLayout title={error ? 'Employee Profile Unavailable' : 'Employee Not Found'}>
        <div className="employees-editorial-wrapper">
          <div className="emp-page">
            <div className="emp-profile-nav">
              <Link href="/employees" className="emp-profile-back-link">
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Return to Employees Directory</span>
              </Link>
            </div>
            {error ? (
              <ErrorBanner
                resource="this employee dossier"
                detail={error}
                onRetry={() => refetch()}
                retrying={loading}
              />
            ) : (
              <div className="emp-empty-state">
                <div className="emp-empty-icon">
                  <UserCheck className="w-6 h-6" />
                </div>
                <h3 className="emp-empty-title">Employee Profile Not Found</h3>
                <p className="emp-empty-desc">
                  The requested record may have been archived, transferred, or does not exist in the active directory.
                </p>
                <Link href="/employees" className="emp-btn-primary">
                  <span>Browse Directory</span>
                </Link>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const statusClass = `emp-badge emp-badge-${(employee.status || 'full_time').toLowerCase()}`;

  return (
    <DashboardLayout title={`Employee: ${employee.firstName} ${employee.lastName}`}>
      <div className="employees-editorial-wrapper">
        <div className="emp-page">
          {/* Breadcrumb & Dossier Badge Bar */}
          <div className="emp-profile-nav">
            <Link href="/employees" className="emp-profile-back-link">
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Directory</span>
            </Link>
            <div className="emp-profile-dossier-pill">
              <span className="pulse-dot" />
              <span>DOSSIER #{employee.employeeNumber || 'UNASSIGNED'} &bull; VERIFIED</span>
            </div>
          </div>

          {/* Profile Hero Card */}
          <div className="emp-profile-hero">
            <div className="emp-profile-hero-content">
              {/* Left Identity Section */}
              <div className="emp-profile-hero-left">
                <div className="emp-profile-avatar-wrap">
                  {employee.avatarUrl ? (
                    <img
                      src={employee.avatarUrl}
                      alt={`${employee.firstName} ${employee.lastName}`}
                      className="emp-profile-avatar-img"
                    />
                  ) : (
                    <div className="emp-profile-avatar-fallback">
                      {employee.firstName?.[0]}
                      {employee.lastName?.[0]}
                    </div>
                  )}

                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => setIsAvatarModalOpen(true)}
                      title="Update profile picture"
                      className="emp-profile-camera-btn"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="emp-profile-hero-info">
                  <div className="emp-profile-title-row">
                    <h1 className="emp-profile-name">
                      {employee.firstName} {employee.lastName}
                    </h1>
                    <span className={statusClass}>
                      {employee.status ? employee.status.replace('_', ' ') : 'ACTIVE'}
                    </span>
                  </div>

                  <div className="emp-profile-role-line">
                    <span>{employee.designation?.title || 'Team Member'}</span>
                    <span className="separator">&bull;</span>
                    <span>{employee.department?.name || 'Department Unassigned'}</span>
                  </div>

                  <div className="emp-profile-meta-row">
                    <div className="emp-profile-meta-item">
                      <Hash />
                      <span>ID:</span>
                      <span className="mono-val">{employee.employeeNumber || '—'}</span>
                    </div>
                    {employee.workLocation && (
                      <div className="emp-profile-meta-item">
                        <MapPin />
                        <span>{employee.workLocation}</span>
                      </div>
                    )}
                    {employee.joiningDate && (
                      <div className="emp-profile-meta-item">
                        <CalendarDays />
                        <span>Joined:</span>
                        <span className="mono-val">
                          {new Date(employee.joiningDate).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                    {employee.manager && (
                      <div className="emp-profile-meta-item">
                        <UserCheck />
                        <span>Reports to:</span>
                        <Link
                          href={`/employees/${employee.manager.id}`}
                          className="emp-profile-link-accent"
                        >
                          {employee.manager.firstName} {employee.manager.lastName}
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Action Bar */}
              <div className="emp-profile-hero-actions">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setShowEdit(true)}
                    className="emp-btn-primary"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Edit Profile</span>
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setIsAvatarModalOpen(true)}
                    className="emp-btn-secondary"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>Change Photo</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 4-Card Quick Metrics Strip */}
          <div className="emp-quick-stats">
            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Service Tenure</div>
                <div className="emp-quick-stat-value">{tenureText}</div>
              </div>
              <div className="emp-quick-stat-icon">
                <Award className="w-5 h-5" />
              </div>
            </div>

            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Monthly Base Salary</div>
                <div className="emp-quick-stat-value">
                  {baseSalary ? formatCurrency(baseSalary) : 'Grade Plan'}
                </div>
              </div>
              <div className="emp-quick-stat-icon">
                <Banknote className="w-5 h-5" />
              </div>
            </div>

            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Remaining PTO</div>
                <div className="emp-quick-stat-value">{totalRemainingLeave} Days</div>
              </div>
              <div className="emp-quick-stat-icon">
                <Calendar className="w-5 h-5" />
              </div>
            </div>

            <div className="emp-quick-stat-card">
              <div>
                <div className="emp-quick-stat-label">Team Hierarchy</div>
                <div className="emp-quick-stat-value">
                  {employee.subordinates?.length || 0} Direct{' '}
                  {employee.subordinates?.length === 1 ? 'Report' : 'Reports'}
                </div>
              </div>
              <div className="emp-quick-stat-icon">
                <Users className="w-5 h-5" />
              </div>
            </div>
          </div>

          {/* Profile Tabs Navigation */}
          <div className="emp-profile-tabs-nav">
            <button
              type="button"
              onClick={() => setActiveTab('overview')}
              className={`emp-profile-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            >
              <Briefcase className="w-3.5 h-3.5" />
              <span>Overview & Bio</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('employment')}
              className={`emp-profile-tab-btn ${activeTab === 'employment' ? 'active' : ''}`}
            >
              <FileSignature className="w-3.5 h-3.5" />
              <span>Employment & Contract</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('compensation')}
              className={`emp-profile-tab-btn ${activeTab === 'compensation' ? 'active' : ''}`}
            >
              <Banknote className="w-3.5 h-3.5" />
              <span>Compensation & Grade</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('leaves')}
              className={`emp-profile-tab-btn ${activeTab === 'leaves' ? 'active' : ''}`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Leave Entitlements</span>
              <span className="tab-count">{totalRemainingLeave}d</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('team')}
              className={`emp-profile-tab-btn ${activeTab === 'team' ? 'active' : ''}`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Team & Hierarchy</span>
              <span className="tab-count">{employee.subordinates?.length || 0}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('emergency')}
              className={`emp-profile-tab-btn ${activeTab === 'emergency' ? 'active' : ''}`}
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Emergency Contact</span>
            </button>
          </div>

          {/* TAB 1: OVERVIEW & BIOGRAPHY */}
          {activeTab === 'overview' && (
            <div className="emp-profile-content-2col">
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">CONTACT & IDENTITY</span>
                    <h2 className="emp-profile-card-title">
                      <UserCheck />
                      <span>Professional Profile</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  <div className="emp-profile-kv-grid">
                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Official Work Email</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.email}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Contact Telephone</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.phone || 'Not recorded'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Department</span>
                      <span className="emp-profile-kv-value">
                        {employee.department?.name || 'Unassigned'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Official Designation</span>
                      <span className="emp-profile-kv-value">
                        {employee.designation?.title || 'Staff Member'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Reporting Line</span>
                      <span className="emp-profile-kv-value">
                        {employee.manager ? (
                          <Link
                            href={`/employees/${employee.manager.id}`}
                            className="emp-profile-link-accent"
                          >
                            {employee.manager.firstName} {employee.manager.lastName}
                          </Link>
                        ) : (
                          'Executive Management / Root'
                        )}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Primary Work Site</span>
                      <span className="emp-profile-kv-value">
                        {employee.workLocation || 'Headquarters / Main Campus'}
                      </span>
                    </div>
                  </div>

                  {employee.profileSummary && (
                    <div className="emp-profile-summary-box">
                      <p>{employee.profileSummary}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Personal & Compliance Details */}
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">PERSONAL DATA</span>
                    <h2 className="emp-profile-card-title">
                      <ShieldCheck />
                      <span>Personal & Residential</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  <div className="emp-profile-kv-grid">
                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Date of Birth</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.dateOfBirth
                          ? new Date(employee.dateOfBirth).toLocaleDateString()
                          : 'Not provided'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Gender</span>
                      <span className="emp-profile-kv-value">
                        {employee.gender || 'Not specified'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item" style={{ gridColumn: '1 / -1' }}>
                      <span className="emp-profile-kv-label">Registered Residential Address</span>
                      <span className="emp-profile-kv-value">
                        {employee.address || 'Confidential / Not provided on record'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Account Security Status</span>
                      <span className="emp-profile-kv-value">
                        <span className="emp-badge emp-badge-active">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Identity Verified</span>
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: EMPLOYMENT & CONTRACT */}
          {activeTab === 'employment' && (
            <div className="emp-profile-content-2col">
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">TERMS OF EMPLOYMENT</span>
                    <h2 className="emp-profile-card-title">
                      <FileSignature />
                      <span>Contractual Engagement</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  <div className="emp-profile-kv-grid">
                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Engagement Category</span>
                      <span className="emp-profile-kv-value">
                        <span className={statusClass}>
                          {employee.status ? employee.status.replace('_', ' ') : 'FULL TIME'}
                        </span>
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Official Joining Date</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.joiningDate
                          ? new Date(employee.joiningDate).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })
                          : '—'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Contract Expiry Date</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.contractEndDate
                          ? new Date(employee.contractEndDate).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })
                          : employee.status === 'CONTRACT'
                          ? 'Not specified'
                          : 'Permanent Open-Ended'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Probation / Status</span>
                      <span className="emp-profile-kv-value">
                        {employee.status === 'PROBATIONARY' ? 'In Probationary Period' : 'Confirmed Permanent'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Assigned Work Station</span>
                      <span className="emp-profile-kv-value">
                        {employee.workLocation || 'Headquarters'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Timezone Preference</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.timezone || 'Europe/London (Default)'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Department & Organizational Unit */}
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">ORGANIZATIONAL ALIGNMENT</span>
                    <h2 className="emp-profile-card-title">
                      <Building2 />
                      <span>Departmental Assignment</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  <div className="emp-profile-kv-grid">
                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Department Name</span>
                      <span className="emp-profile-kv-value">
                        {employee.department?.name || 'Unassigned'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Department Code</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.department?.code || '—'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Grade / Designation</span>
                      <span className="emp-profile-kv-value">
                        {employee.designation?.title || 'General Staff'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Supervising Officer</span>
                      <span className="emp-profile-kv-value">
                        {employee.manager ? (
                          <Link
                            href={`/employees/${employee.manager.id}`}
                            className="emp-profile-link-accent"
                          >
                            {employee.manager.firstName} {employee.manager.lastName}
                          </Link>
                        ) : (
                          'None'
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: COMPENSATION & GRADE */}
          {activeTab === 'compensation' && (
            <div className="emp-profile-content-2col">
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">REMUNERATION PLAN</span>
                    <h2 className="emp-profile-card-title">
                      <Banknote />
                      <span>Active Salary Assignment</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  {activeSalaryStructure ? (
                    <div>
                      <div className="emp-profile-comp-banner">
                        <div>
                          <div className="emp-profile-comp-label">Base Compensation Rate</div>
                          <div className="emp-profile-comp-amount">
                            {formatCurrency(activeSalaryStructure.baseSalary)}
                          </div>
                        </div>
                        <div>
                          <span className="emp-badge emp-badge-active">
                            {activeSalaryStructure.salaryStructure?.name || 'Standard Band'}
                          </span>
                        </div>
                      </div>

                      {activeSalaryStructure.salaryStructure?.components &&
                        activeSalaryStructure.salaryStructure.components.length > 0 && (
                          <div className="emp-profile-comp-breakdown">
                            <span className="emp-profile-kv-label" style={{ marginTop: '8px' }}>
                              Salary Structure Components
                            </span>
                            {activeSalaryStructure.salaryStructure.components.map(
                              (comp: any, idx: number) => (
                                <div key={idx} className="emp-profile-comp-row">
                                  <span style={{ fontWeight: 500 }}>{comp.name}</span>
                                  <span className="emp-profile-kv-mono">
                                    {comp.type} &bull; {comp.calculationType}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        )}
                    </div>
                  ) : (
                    <div className="emp-empty-state" style={{ padding: '32px 16px' }}>
                      <p className="emp-empty-desc">
                        No active salary structure has been assigned to this employee record yet.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Statutory & Payslips Note */}
              <div className="emp-profile-card">
                <div className="emp-profile-card-header">
                  <div className="emp-profile-card-header-left">
                    <span className="emp-profile-card-overline">PAYROLL DISBURSEMENTS</span>
                    <h2 className="emp-profile-card-title">
                      <FileSignature />
                      <span>Statutory RTI & Payslips</span>
                    </h2>
                  </div>
                </div>

                <div className="emp-profile-card-body">
                  <p style={{ fontSize: '13px', color: 'var(--emp-text-secondary)', lineHeight: 1.6 }}>
                    Comprehensive statutory payroll calculations, PAYE tax code deductions, National
                    Insurance brackets, and HMRC Real Time Information (RTI) submissions are processed
                    within the Payroll module.
                  </p>

                  <div style={{ marginTop: '12px' }}>
                    <Link href="/payroll" className="emp-btn-secondary">
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open Payroll Module</span>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: LEAVE ENTITLEMENTS */}
          {activeTab === 'leaves' && (
            <div className="emp-profile-card">
              <div className="emp-profile-card-header">
                <div className="emp-profile-card-header-left">
                  <span className="emp-profile-card-overline">CURRENT YEAR ENTITLEMENTS</span>
                  <h2 className="emp-profile-card-title">
                    <CalendarDays />
                    <span>Annual Leave & Statutory Entitlements</span>
                  </h2>
                </div>

                <Link href="/leaves" className="emp-btn-secondary">
                  <span>Leave Management</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>

              <div className="emp-profile-card-body">
                {employee.leaveBalances && employee.leaveBalances.length > 0 ? (
                  <div className="emp-profile-leaves-grid">
                    {employee.leaveBalances.map((lb: any, idx: number) => {
                      const allocated = lb.allocatedDays || 0;
                      const remaining = lb.remainingDays || 0;
                      const used = allocated - remaining;
                      const pctUsed = allocated > 0 ? Math.min(100, Math.round((used / allocated) * 100)) : 0;

                      return (
                        <div key={idx} className="emp-profile-leave-card">
                          <div className="emp-profile-leave-top">
                            <span className="emp-profile-leave-name">
                              {lb.leaveType?.name || 'Leave Entitlement'}
                            </span>
                            <span className="emp-profile-leave-pill">{remaining} days left</span>
                          </div>

                          <div className="emp-profile-leave-progress-bg">
                            <div
                              className="emp-profile-leave-progress-fill"
                              style={{ width: `${pctUsed}%` }}
                            />
                          </div>

                          <div className="emp-profile-leave-meta">
                            <span>Allocated: {allocated}d</span>
                            <span>Used: {used > 0 ? used : 0}d ({pctUsed}%)</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="emp-empty-state" style={{ padding: '36px 16px' }}>
                    <p className="emp-empty-desc">
                      No leave balance records have been generated for the current calendar year. Balances
                      are automatically initialized upon employment start or first leave booking.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: TEAM & REPORTING HIERARCHY */}
          {activeTab === 'team' && (
            <div className="emp-profile-card">
              <div className="emp-profile-card-header">
                <div className="emp-profile-card-header-left">
                  <span className="emp-profile-card-overline">ORGANIZATIONAL SUBORDINATES</span>
                  <h2 className="emp-profile-card-title">
                    <Users />
                    <span>Direct Reports & Supervised Team</span>
                  </h2>
                </div>
                <div className="emp-stat-pill">
                  <span className="count">{employee.subordinates?.length || 0}</span>
                  <span>Direct Members</span>
                </div>
              </div>

              <div className="emp-profile-card-body">
                {employee.subordinates && employee.subordinates.length > 0 ? (
                  <div className="emp-profile-subordinates-grid">
                    {employee.subordinates.map((sub: any) => (
                      <Link
                        key={sub.id}
                        href={`/employees/${sub.id}`}
                        className="emp-profile-subordinate-card"
                      >
                        <div className="emp-profile-subordinate-avatar">
                          {sub.firstName?.[0]}
                          {sub.lastName?.[0]}
                        </div>
                        <div className="emp-profile-subordinate-info">
                          <span className="emp-profile-subordinate-name">
                            {sub.firstName} {sub.lastName}
                          </span>
                          <span className="emp-profile-subordinate-role">
                            {sub.designation?.title || 'Staff Member'} &bull; {sub.employeeNumber || 'ID'}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="emp-empty-state" style={{ padding: '36px 16px' }}>
                    <p className="emp-empty-desc">
                      This employee does not currently have any direct reports assigned in the organizational hierarchy.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 6: EMERGENCY CONTACT */}
          {activeTab === 'emergency' && (
            <div className="emp-profile-card">
              <div className="emp-profile-card-header">
                <div className="emp-profile-card-header-left">
                  <span className="emp-profile-card-overline">EMERGENCY PROTOCOL</span>
                  <h2 className="emp-profile-card-title">
                    <PhoneCall />
                    <span>Designated Emergency Contact</span>
                  </h2>
                </div>

                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setShowEdit(true)}
                    className="emp-btn-secondary"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Update Contact</span>
                  </button>
                )}
              </div>

              <div className="emp-profile-card-body">
                {employee.emergencyContactName ||
                employee.emergencyContact?.name ||
                employee.emergencyContactPhone ||
                employee.emergencyContact?.phone ? (
                  <div className="emp-profile-kv-grid">
                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Contact Full Name</span>
                      <span className="emp-profile-kv-value">
                        {employee.emergencyContactName || employee.emergencyContact?.name || '—'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Primary Telephone</span>
                      <span className="emp-profile-kv-value emp-profile-kv-mono">
                        {employee.emergencyContactPhone || employee.emergencyContact?.phone || '—'}
                      </span>
                    </div>

                    <div className="emp-profile-kv-item">
                      <span className="emp-profile-kv-label">Relationship to Employee</span>
                      <span className="emp-profile-kv-value">
                        {employee.emergencyContactRelation ||
                          employee.emergencyContact?.relation ||
                          'Next of Kin'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="emp-empty-state" style={{ padding: '36px 16px' }}>
                    <p className="emp-empty-desc">
                      No designated emergency contact is currently registered for this employee dossier.
                      {canEdit && ' Click “Update Contact” to register a next of kin or emergency phone.'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile Picture Avatar Modal */}
      <AvatarModal
        isOpen={isAvatarModalOpen}
        onClose={() => setIsAvatarModalOpen(false)}
        onSuccess={async () => {
          await queryClient.invalidateQueries({ queryKey: employeeKeys.detail(id) });
        }}
      />

      {/* Edit Employee Form Modal */}
      {employee && (
        <EmployeeFormModal
          open={showEdit}
          mode="edit"
          initial={employeeToForm(employee)}
          onClose={() => setShowEdit(false)}
          onSubmit={async (payload) => {
            await api.patch(`/employees/${id}`, payload);
            await queryClient.invalidateQueries({ queryKey: employeeKeys.detail(id) });
          }}
        />
      )}
    </DashboardLayout>
  );
}
