'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Users, UserPlus, RefreshCw, ShieldOff } from 'lucide-react';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import { PaginationControls } from '../../../../components/ui/pagination';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import { useAuth } from '../../../../context/auth-context';
import { useFocusTrap } from '../../../../hooks/use-focus-trap';
import { SystemRole } from '@ems/shared';
import '../../../../styles/admin.css';

interface ManagedUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  isActive: boolean;
  emailVerified?: boolean;
  roles: string[];
  employee?: { id: string; employeeNumber?: string } | null;
  createdAt?: string;
}

const PAGE_SIZE = 15;

/**
 * User management (Phase 2 item 10 — admin screens).
 *
 * API contract (worker 1 — admin user endpoints):
 *   GET   /auth/users              → paginated users
 *   POST  /auth/invitations        → { email, roleIds[] } creates an invitation
 *   PATCH /auth/users/:id          → { isActive } deactivates/reactivates
 *
 * If these endpoints are not deployed yet the page fails loudly with the
 * server's message instead of rendering a fabricated roster.
 */
export default function AdminUsersPage() {
  const { hasRole } = useAuth();
  const canManage = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>(SystemRole.EMPLOYEE);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);

  const inviteModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(inviteModalRef, { isActive: showInvite, onEscape: () => setShowInvite(false) });

  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const fetchUsers = useCallback(async (pageToLoad: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPaginated<ManagedUser>('/auth/users', {
        params: { page: pageToLoad, limit: PAGE_SIZE },
      });
      setUsers(res.items);
      setTotal(res.total);
      setPage(res.page);
    } catch (err: any) {
      setError(err?.message || 'Could not load users. The admin user API may not be deployed yet.');
      setUsers([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) fetchUsers(1);
    else setLoading(false);
  }, [canManage, fetchUsers]);

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteBusy(true);
    setInviteError(null);
    setInviteSent(false);
    try {
      // Invitation-based onboarding (Phase 1 B2): HR invites by email; the
      // invitee sets their password via /invitation-accept.
      await api.post('/auth/invitations', { email: inviteEmail, roleIds: [inviteRole] });
      setInviteSent(true);
      setInviteEmail('');
    } catch (err: any) {
      setInviteError(err?.message || 'Could not send the invitation.');
    } finally {
      setInviteBusy(false);
    }
  };

  const toggleActive = async (u: ManagedUser) => {
    const next = !u.isActive;
    const label = next ? 'reactivate' : 'deactivate';
    if (!window.confirm(`${next ? 'Reactivate' : 'Deactivate'} ${u.email}?`)) return;
    setActionBusy(u.id);
    try {
      await api.patch(`/auth/users/${u.id}`, { isActive: next });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, isActive: next } : x)));
    } catch (err: any) {
      setError(`Could not ${label} ${u.email}: ${err?.message || 'request failed'}`);
    } finally {
      setActionBusy(null);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout title="User Management">
        <div className="adm-page">
          <ErrorBanner
            resource="user management"
            detail="Your role does not include user administration (USER:MANAGE)."
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="User Management">
      <div className="adm-page">
        <div className="adm-header">
          <div>
            <h1 className="adm-title">User Management</h1>
            <p className="adm-subtitle">
              Invite users, assign roles, and deactivate accounts. Accounts are
              created via invitation only — there is no open self-registration.
            </p>
          </div>
          <button className="adm-btn adm-btn-primary" onClick={() => setShowInvite(true)}>
            <UserPlus className="w-4 h-4" />
            Invite user
          </button>
        </div>

        {error && (
          <ErrorBanner resource="users" detail={error} onRetry={() => fetchUsers(1)} retrying={loading} />
        )}

        <div className="adm-card">
          {loading ? (
            <SkeletonTable rows={8} columns={5} />
          ) : users.length === 0 && !error ? (
            <div className="adm-empty">
              <Users className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              No users found.
            </div>
          ) : (
            <>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Roles</th>
                    <th>Status</th>
                    <th>Verified</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="font-semibold">
                          {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                        </div>
                        <div className="text-xs text-slate-500 font-mono">{u.email}</div>
                      </td>
                      <td>
                        {u.roles?.length
                          ? u.roles.map((r) => (
                              <span key={r} className="adm-role-pill">{r}</span>
                            ))
                          : <span className="text-xs text-slate-400">No roles</span>}
                      </td>
                      <td>
                        <span className={`adm-status-dot ${u.isActive ? 'adm-status-active' : 'adm-status-inactive'}`}>
                          {u.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="text-xs text-slate-500">
                        {u.emailVerified ? 'Yes' : 'Pending'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className={`adm-btn adm-btn-sm ${u.isActive ? 'adm-btn-danger' : 'adm-btn-ghost'}`}
                          disabled={actionBusy === u.id}
                          onClick={() => toggleActive(u)}
                        >
                          {actionBusy === u.id ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <ShieldOff className="w-3.5 h-3.5" />
                          )}
                          {u.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: '16px' }}>
                <PaginationControls
                  page={page}
                  limit={PAGE_SIZE}
                  total={total}
                  onPageChange={(p) => fetchUsers(p)}
                />
              </div>
            </>
          )}
        </div>

        {showInvite && (
          <div className="adm-modal-backdrop" onClick={() => setShowInvite(false)}>
            <div
              ref={inviteModalRef}
              className="adm-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="invite-modal-title"
            >
              <h3 id="invite-modal-title">Invite a user</h3>
              <p className="adm-modal-sub">
                An invitation email is sent with a one-time link. The invitee
                sets their own password via the invitation-accept page.
              </p>
              {inviteError && <div className="adm-error" role="alert">{inviteError}</div>}
              {inviteSent && (
                <div
                  className="adm-error"
                  role="status"
                  style={{ background: '#e8f0ec', borderColor: '#cfe0d5', color: '#2c5f4a' }}
                >
                  Invitation sent. The invitee can now activate their account from the email link.
                </div>
              )}
              <form onSubmit={sendInvite}>
                <div className="adm-form-group">
                  <label className="adm-label" htmlFor="invite-email">Work email</label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    className="adm-input"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="name@company.com"
                  />
                </div>
                <div className="adm-form-group">
                  <label className="adm-label" htmlFor="invite-role">Initial role</label>
                  <select
                    id="invite-role"
                    className="adm-select"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    {Object.values(SystemRole).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2 justify-end mt-4">
                  <button
                    type="button"
                    className="adm-btn adm-btn-ghost"
                    onClick={() => setShowInvite(false)}
                  >
                    Close
                  </button>
                  <button type="submit" className="adm-btn adm-btn-primary" disabled={inviteBusy}>
                    {inviteBusy ? 'Sending…' : 'Send invitation'}
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
