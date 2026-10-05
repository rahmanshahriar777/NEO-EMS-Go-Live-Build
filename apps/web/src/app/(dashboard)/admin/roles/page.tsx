'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import { useAdminRolesQuery, adminKeys } from '../../../../lib/queries';
import { ErrorBanner } from '../../../../components/ui/error-banner';
import { SkeletonTable } from '../../../../components/ui/skeleton';
import { useAuth } from '../../../../context/auth-context';
import { useFocusTrap } from '../../../../hooks/use-focus-trap';
import { SystemRole } from '@ems/shared';
import { ALL_PERMISSIONS, PERMISSION_SUBJECTS } from '../../../../lib/permissions';
import '../../../../styles/admin.css';

interface Role {
  id: string;
  name: string;
  description?: string;
  isSystem?: boolean;
  permissions?: Array<{ code?: string; action?: string; subject?: string } | string>;
}

/**
 * Role editor (Phase 2 item 10): grant the 60 seeded permissions to roles.
 *
 * API contract (worker 1 — roles endpoints):
 *   GET    /roles            → Role[] (with permissions)
 *   POST   /roles            → { name, description, permissionIds[] }
 *   PATCH  /roles/:id        → { name?, description?, permissionIds[] }
 *   DELETE /roles/:id        → deletes a non-system role
 *
 * Permission codes are `SUBJECT:ACTION` (see auth.service extractPermissions).
 * The editor posts the selected codes; the API maps them to permission rows.
 */
export default function AdminRolesPage() {
  const { hasRole, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const canManage = hasRole(SystemRole.SUPER_ADMIN) || hasPermission('USER:MANAGE');

  const { data: rolesData, isPending: loading, error: queryError, refetch } = useAdminRolesQuery(canManage);
  const roles: Role[] = rolesData || [];
  const error = queryError ? (queryError as Error).message || 'Could not load roles.' : null;

  const [editing, setEditing] = useState<Role | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const permCodesOf = (role: Role): Set<string> =>
    new Set(
      (role.permissions || []).map((p) =>
        typeof p === 'string' ? p : p.code || `${p.subject}:${p.action}`,
      ),
    );

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormDesc('');
    setSelected(new Set());
    setFormError(null);
  };

  const openEdit = (role: Role) => {
    setEditing(role);
    setFormName(role.name);
    setFormDesc(role.description || '');
    setSelected(permCodesOf(role));
    setFormError(null);
  };

  const togglePerm = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const toggleSubject = (subject: string) => {
    const codes = ALL_PERMISSIONS.filter((p) => p.subject === subject).map((p) => p.code);
    const allOn = codes.every((c) => selected.has(c));
    setSelected((prev) => {
      const next = new Set(prev);
      codes.forEach((c) => (allOn ? next.delete(c) : next.add(c)));
      return next;
    });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: formName.trim().toUpperCase().replace(/\s+/g, '_'),
        description: formDesc.trim() || undefined,
        permissionIds: Array.from(selected),
      };
      if (editing) {
        await api.patch(`/roles/${editing.id}`, body);
      } else {
        await api.post('/roles', body);
      }
      setModalOpen(false);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
    } catch (err: any) {
      setFormError(err?.message || 'Could not save the role.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    if (role.isSystem) return;
    if (!window.confirm(`Delete the role "${role.name}"? Users holding it lose those permissions.`)) return;
    try {
      await api.delete(`/roles/${role.id}`);
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
    } catch (err: any) {
      alert(`Could not delete ${role.name}: ${err?.message || 'request failed'}`);
    }
  };

  const [modalOpen, setModalOpen] = useState(false);
  const roleModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(roleModalRef, { isActive: modalOpen, onEscape: () => setModalOpen(false) });

  if (!canManage) {
    return (
      <DashboardLayout title="Role Editor">
        <div className="adm-page">
          <ErrorBanner
            resource="role editor"
            detail="Your role does not include role administration (USER:MANAGE)."
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Role Editor">
      <div className="adm-page">
        <div className="adm-header">
          <div>
            <h1 className="adm-title">Role Editor</h1>
            <p className="adm-subtitle">
              Grant the {ALL_PERMISSIONS.length} seeded permissions to roles.
              System roles are built-in; custom roles (e.g. Payroll Officer) need
              no code changes.
            </p>
          </div>
          <button
            className="adm-btn adm-btn-primary"
            onClick={() => {
              openCreate();
              setModalOpen(true);
            }}
          >
            <Plus className="w-4 h-4" />
            New role
          </button>
        </div>

        {error && (
          <ErrorBanner resource="roles" detail={error} onRetry={() => refetch()} retrying={loading} />
        )}

        <div className="adm-card">
          {loading ? (
            <SkeletonTable rows={6} columns={3} />
          ) : roles.length === 0 && !error ? (
            <div className="adm-empty">
              <KeyRound className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              No roles returned by the API.
            </div>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => {
                  const codes = permCodesOf(role);
                  return (
                    <tr key={role.id}>
                      <td>
                        <div className="font-semibold font-mono text-[13px]">{role.name}</div>
                        <div className="text-xs text-slate-500">
                          {role.description || (role.isSystem ? 'System role' : 'Custom role')}
                        </div>
                      </td>
                      <td>
                        <span className="adm-role-pill">
                          {codes.size} / {ALL_PERMISSIONS.length} permissions
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="adm-btn adm-btn-sm adm-btn-ghost"
                          style={{ marginRight: '8px' }}
                          onClick={() => {
                            openEdit(role);
                            setModalOpen(true);
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </button>
                        {!role.isSystem && (
                          <button
                            className="adm-btn adm-btn-sm adm-btn-danger"
                            onClick={() => remove(role)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {modalOpen && (
          <div className="adm-modal-backdrop" onClick={() => setModalOpen(false)}>
            <div
              ref={roleModalRef}
              className="adm-modal"
              style={{ maxWidth: '720px' }}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="role-modal-title"
            >
              <h3 id="role-modal-title">{editing ? `Edit role: ${editing.name}` : 'New role'}</h3>
              <p className="adm-modal-sub">
                Tick the permissions this role grants. Changes apply to every
                user holding the role on their next sign-in (permissions are
                embedded in the session).
              </p>
              {formError && <div className="adm-error" role="alert">{formError}</div>}
              <form onSubmit={save}>
                <div className="adm-form-group">
                  <label className="adm-label" htmlFor="role-name">Role name</label>
                  <input
                    id="role-name"
                    className="adm-input"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="PAYROLL_OFFICER"
                    disabled={!!editing?.isSystem}
                  />
                </div>
                <div className="adm-form-group">
                  <label className="adm-label" htmlFor="role-desc">Description</label>
                  <input
                    id="role-desc"
                    className="adm-input"
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    placeholder="What this role is for"
                  />
                </div>

                <div className="adm-label">
                  Permissions ({selected.size} / {ALL_PERMISSIONS.length} selected)
                </div>
                <div className="adm-perm-grid">
                  {PERMISSION_SUBJECTS.map((subject) => {
                    const perms = ALL_PERMISSIONS.filter((p) => p.subject === subject);
                    const onCount = perms.filter((p) => selected.has(p.code)).length;
                    return (
                      <div key={subject} className="adm-perm-subject">
                        <h4>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={onCount === perms.length}
                              onChange={() => toggleSubject(subject)}
                            />
                            {subject} ({onCount}/{perms.length})
                          </label>
                        </h4>
                        {perms.map((p) => (
                          <label key={p.code} className="adm-perm-check">
                            <input
                              type="checkbox"
                              checked={selected.has(p.code)}
                              onChange={() => togglePerm(p.code)}
                            />
                            <span className="font-mono text-[11px]">{p.action}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>

                <div className="flex gap-2 justify-end mt-6">
                  <button
                    type="button"
                    className="adm-btn adm-btn-ghost"
                    onClick={() => setModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="adm-btn adm-btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : editing ? 'Save role' : 'Create role'}
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
