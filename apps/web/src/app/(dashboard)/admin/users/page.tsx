'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Users, UserPlus, RefreshCw, ShieldOff, Mail, Clock, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAdminUsersQuery, adminKeys } from '../../../../lib/queries';
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

interface InvitationItem {
  id: string;
  email: string;
  role: string;
  employeeId?: string | null;
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt: string;
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
  const queryClient = useQueryClient();
  const canManage = hasRole(SystemRole.SUPER_ADMIN, SystemRole.HR_ADMIN);

  const [activeTab, setActiveTab] = useState<'users' | 'invitations'>('users');
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [loadingInvitations, setLoadingInvitations] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const { data, isPending: loading, error: queryError, refetch } = useAdminUsersQuery(page, PAGE_SIZE, canManage);
  const users: ManagedUser[] = data?.items || [];
  const total = data?.total || 0;
  const error = queryError ? (queryError as Error).message || 'Could not load users.' : null;

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>(SystemRole.EMPLOYEE);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [lastInvitedEmail, setLastInvitedEmail] = useState('');
  const [copied, setCopied] = useState(false);

  const inviteModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(inviteModalRef, { isActive: showInvite, onEscape: () => setShowInvite(false) });

  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const fetchInvitations = useCallback(async () => {
    if (!canManage) return;
    setLoadingInvitations(true);
    try {
      const res: any = await api.get('/auth/invitations');
      const items = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      setInvitations(items);
    } catch {
      // Non-blocking
    } finally {
      setLoadingInvitations(false);
    }
  }, [canManage]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  const revokeInvitation = async (id: string, email: string) => {
    if (!window.confirm(`Revoke pending invitation for ${email}?`)) return;
    setRevokingId(id);
    try {
      await api.delete(`/auth/invitations/${id}`);
      await fetchInvitations();
    } catch (err: any) {
      alert(`Could not revoke invitation: ${err?.message || 'request failed'}`);
    } finally {
      setRevokingId(null);
    }
  };

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteBusy(true);
    setInviteError(null);
    setInviteSent(false);
    setCreatedInviteUrl(null);
    try {
      const emailToSend = inviteEmail.trim();
      setLastInvitedEmail(emailToSend);
      // Invitation-based onboarding (Phase 1 B2): HR invites by email; the
      // invitee sets their password via /invitation-accept.
      const res: any = await api.post('/auth/invitations', { email: emailToSend, role: inviteRole, roleIds: [inviteRole] });
      setInviteSent(true);
      const returnedUrl = res?.data?.inviteUrl || res?.inviteUrl;
      if (returnedUrl) {
        setCreatedInviteUrl(returnedUrl);
      }
      setInviteEmail('');
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
      await fetchInvitations();
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
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
    } catch (err: any) {
      alert(`Could not ${label} ${u.email}: ${err?.message || 'request failed'}`);
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
          <ErrorBanner resource="users" detail={error} onRetry={() => refetch()} retrying={loading} />
        )}

        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid #e7e4df', paddingBottom: '12px' }}>
          <button
            type="button"
            onClick={() => setActiveTab('users')}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              background: activeTab === 'users' ? '#2c5f4a' : '#f0eeea',
              color: activeTab === 'users' ? '#fff' : '#6b6560',
              border: 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Users className="w-4 h-4" />
            <span>Active Users ({total})</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('invitations');
              fetchInvitations();
            }}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 600,
              background: activeTab === 'invitations' ? '#2c5f4a' : '#f0eeea',
              color: activeTab === 'invitations' ? '#fff' : '#6b6560',
              border: 'none',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Mail className="w-4 h-4" />
            <span>Pending Invitations</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 7px',
                borderRadius: '999px',
                background: activeTab === 'invitations' ? 'rgba(255,255,255,0.25)' : '#d4e3da',
                color: activeTab === 'invitations' ? '#fff' : '#2c5f4a',
                fontWeight: 700,
              }}
            >
              {invitations.filter((i) => !i.acceptedAt).length}
            </span>
          </button>
        </div>

        <div className="adm-card">
          {activeTab === 'users' ? (
            loading ? (
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
                    onPageChange={(p) => setPage(p)}
                  />
                </div>
              </>
            )
          ) : (
            loadingInvitations ? (
              <SkeletonTable rows={4} columns={5} />
            ) : invitations.length === 0 ? (
              <div className="adm-empty">
                <Mail className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                No invitations found. Use the "Invite user" button above to send a new invitation.
              </div>
            ) : (
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Invitee Email</th>
                    <th>Role</th>
                    <th>Sent Date</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => {
                    const isAccepted = !!inv.acceptedAt;
                    const isExpired = !isAccepted && new Date(inv.expiresAt) <= new Date();
                    return (
                      <tr key={inv.id}>
                        <td>
                          <div className="font-semibold font-mono text-xs">{inv.email}</div>
                        </td>
                        <td>
                          <span className="adm-role-pill">{inv.role}</span>
                        </td>
                        <td className="text-xs text-slate-500">
                          {new Date(inv.createdAt).toLocaleDateString()}
                        </td>
                        <td>
                          {isAccepted ? (
                            <span className="adm-status-dot adm-status-active">
                              Accepted
                            </span>
                          ) : isExpired ? (
                            <span className="adm-status-dot adm-status-inactive">
                              Expired
                            </span>
                          ) : (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: '12px',
                                color: '#b8860b',
                                fontWeight: 600,
                              }}
                            >
                              <Clock className="w-3.5 h-3.5" />
                              Pending
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {!isAccepted && (
                            <button
                              className="adm-btn adm-btn-sm adm-btn-danger"
                              disabled={revokingId === inv.id}
                              onClick={() => revokeInvitation(inv.id, inv.email)}
                              title="Revoke this pending invitation"
                            >
                              {revokingId === inv.id ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
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
                  style={{
                    background: '#e8f0ec',
                    borderColor: '#cfe0d5',
                    color: '#2c5f4a',
                    padding: '12px',
                    borderRadius: '8px',
                    marginBottom: '16px',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '2px' }}>
                    Invitation sent to {lastInvitedEmail || 'the user'}!
                  </div>
                  <div style={{ fontSize: '13px', opacity: 0.9 }}>
                    An activation email is queued for delivery.
                  </div>
                  {createdInviteUrl && (
                    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #b6d3c3' }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#1a4131', marginBottom: '4px' }}>
                        One-time invitation link (valid 72 hours):
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <input
                          type="text"
                          readOnly
                          value={createdInviteUrl}
                          className="adm-input"
                          style={{ fontSize: '12px', padding: '6px 8px', fontFamily: 'monospace', flex: 1, background: '#fff' }}
                          onClick={(e) => (e.target as HTMLInputElement).select()}
                        />
                        <button
                          type="button"
                          className="adm-btn adm-btn-primary"
                          style={{ fontSize: '12px', padding: '6px 12px', whiteSpace: 'nowrap' }}
                          onClick={() => {
                            navigator.clipboard.writeText(createdInviteUrl);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          }}
                        >
                          {copied ? 'Copied!' : 'Copy Link'}
                        </button>
                      </div>
                      <div style={{ fontSize: '11px', color: '#4a6f5d', marginTop: '4px' }}>
                        You can copy and send this link directly to the invitee if email delivery is delayed.
                      </div>
                    </div>
                  )}
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
