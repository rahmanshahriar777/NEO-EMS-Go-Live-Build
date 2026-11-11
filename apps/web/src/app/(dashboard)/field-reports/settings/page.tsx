'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  SlidersHorizontal,
  Shield,
  UserCheck,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../../../../context/auth-context';
import { SystemRole, FieldReportDownloadVariant } from '@ems/shared';
import {
  useFieldReportPoliciesQuery,
  useFieldReportDelegationsQuery,
  FieldReportPolicyItem,
} from '../../../../lib/field-reports-queries';
import { DashboardLayout } from '../../../../components/layout/dashboard-layout';
import { api } from '../../../../lib/api-client';
import '../../../../styles/field-reports.css';

export default function FieldReportSettingsPage() {
  const { user, hasRole } = useAuth();
  const isHrOrAdmin = hasRole(SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN);

  const { data: serverPolicies, isLoading: policiesLoading, refetch: refetchPolicies } =
    useFieldReportPoliciesQuery();
  const { data: delegations, isLoading: delegationsLoading, refetch: refetchDelegations } =
    useFieldReportDelegationsQuery();

  const [policies, setPolicies] = useState<FieldReportPolicyItem[]>([]);
  const [savingPolicies, setSavingPolicies] = useState(false);
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);

  // New delegation form
  const [delegateEmployeeId, setDelegateEmployeeId] = useState('');
  const [startsAt, setStartsAt] = useState(new Date().toISOString().slice(0, 10));
  const [expiresAt, setExpiresAt] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  );
  const [delegationReason, setDelegationReason] = useState('');
  const [creatingDelegation, setCreatingDelegation] = useState(false);
  const [delegationError, setDelegationError] = useState<string | null>(null);

  useEffect(() => {
    if (serverPolicies) {
      setPolicies(serverPolicies);
    }
  }, [serverPolicies]);

  const handlePolicyChange = (
    role: SystemRole,
    field: 'defaultDownloadVariant' | 'allowDownloadOriginal',
    value: any,
  ) => {
    setPolicies((prev) =>
      prev.map((p) => (p.role === role ? { ...p, [field]: value } : p)),
    );
  };

  const handleSavePolicies = async () => {
    setSavingPolicies(true);
    setPolicyMessage(null);
    try {
      await api.put('/field-reports/policies', { policies });
      setPolicyMessage('Download policies updated successfully.');
      await refetchPolicies();
    } catch (err: any) {
      alert(err?.message || 'Failed to save policies');
    } finally {
      setSavingPolicies(false);
    }
  };

  const handleCreateDelegation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!delegateEmployeeId) {
      setDelegationError('Please enter a delegate employee ID.');
      return;
    }
    setCreatingDelegation(true);
    setDelegationError(null);
    try {
      await api.post('/field-reports/delegations', {
        delegateEmployeeId,
        startsAt: new Date(startsAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        reason: delegationReason.trim() || undefined,
      });
      setDelegateEmployeeId('');
      setDelegationReason('');
      await refetchDelegations();
    } catch (err: any) {
      setDelegationError(err?.message || 'Failed to create delegation');
    } finally {
      setCreatingDelegation(false);
    }
  };

  const handleRevokeDelegation = async (id: string) => {
    if (window.confirm('Revoke this review delegation?')) {
      try {
        await api.delete(`/field-reports/delegations/${id}`);
        await refetchDelegations();
      } catch (err: any) {
        alert(err?.message || 'Failed to revoke delegation');
      }
    }
  };

  return (
    <DashboardLayout title="Field Reporting Settings">
      <div className="field-reports-editorial-wrapper">
        <div className="fr-page max-w-4xl">
          <div className="flex items-center gap-3">
            <Link href="/field-reports" className="fr-btn-secondary p-2 min-h-10 min-w-10">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="fr-title text-2xl flex items-center gap-2">
                <SlidersHorizontal className="w-6 h-6 text-[#2c5f4a]" />
                Field Reporting Settings & Policies
              </h1>
              <p className="fr-subtitle text-xs">
                Configure organization download defaults, Original photo permissions, and reviewer delegations.
              </p>
            </div>
          </div>

          {/* Role Download Policy Matrix */}
          <div className="fr-viewer-card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-600" />
              Role Download Policy Matrix
            </h2>
            <p className="text-xs text-slate-500">
              Control whether roles receive Resized (privacy-sanitized) vs Original (bit-exact) downloads by default.
            </p>
          </div>
          {isHrOrAdmin && (
            <button
              onClick={handleSavePolicies}
              disabled={savingPolicies || policiesLoading}
              className="fr-btn-primary fr-touch-target"
            >
              {savingPolicies ? 'Saving...' : 'Save Policies'}
            </button>
          )}
        </div>

        {policyMessage && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>{policyMessage}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 font-bold uppercase text-[10px]">
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Default Download Variant</th>
                <th className="py-3 px-4 text-center">Allow Original Download</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {policies.map((p) => (
                <tr key={p.role} className="hover:bg-slate-50/50">
                  <td className="py-3 px-4 font-semibold text-slate-800">{p.role}</td>
                  <td className="py-3 px-4">
                    <select
                      disabled={!isHrOrAdmin}
                      className="fr-input text-xs py-1 h-8"
                      value={p.defaultDownloadVariant}
                      onChange={(e) =>
                        handlePolicyChange(
                          p.role,
                          'defaultDownloadVariant',
                          e.target.value as FieldReportDownloadVariant,
                        )
                      }
                    >
                      <option value={FieldReportDownloadVariant.RESIZED}>
                        RESIZED (Privacy stripped)
                      </option>
                      <option value={FieldReportDownloadVariant.ORIGINAL}>
                        ORIGINAL (Full resolution)
                      </option>
                    </select>
                  </td>
                  <td className="py-3 px-4 text-center">
                    <input
                      type="checkbox"
                      disabled={!isHrOrAdmin}
                      checked={p.allowDownloadOriginal}
                      onChange={(e) =>
                        handlePolicyChange(p.role, 'allowDownloadOriginal', e.target.checked)
                      }
                      className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reviewer Delegations */}
      <div className="fr-card p-6 space-y-4">
        <div>
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-blue-600" />
            Reviewer Delegations
          </h2>
          <p className="text-xs text-slate-500">
            Delegate your line-manager review authority to another employee while on leave or traveling.
          </p>
        </div>

        {delegationError && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600" />
            <span>{delegationError}</span>
          </div>
        )}

        {/* Add delegation form */}
        <form onSubmit={handleCreateDelegation} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
          <h3 className="text-xs font-bold uppercase text-slate-700">Create New Delegation</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                Delegate Employee ID *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. emp-uuid"
                className="fr-input w-full text-xs"
                value={delegateEmployeeId}
                onChange={(e) => setDelegateEmployeeId(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Starts At *</label>
              <input
                type="date"
                required
                className="fr-input w-full text-xs"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Expires At *</label>
              <input
                type="date"
                required
                className="fr-input w-full text-xs"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Reason / Notes</label>
            <input
              type="text"
              placeholder="e.g. Annual leave coverage"
              className="fr-input w-full text-xs"
              value={delegationReason}
              onChange={(e) => setDelegationReason(e.target.value)}
            />
          </div>
          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={creatingDelegation}
              className="fr-btn-primary text-xs h-9 min-h-9"
            >
              <Plus className="w-3.5 h-3.5" />
              {creatingDelegation ? 'Delegating...' : 'Delegate Authority'}
            </button>
          </div>
        </form>

        {/* Delegations table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-slate-700 font-bold uppercase text-[10px]">
                <th className="py-2.5 px-3">Manager</th>
                <th className="py-2.5 px-3">Delegate</th>
                <th className="py-2.5 px-3">Start Date</th>
                <th className="py-2.5 px-3">Expiry Date</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {delegations && delegations.length > 0 ? (
                delegations.map((d) => {
                  const isRevoked = Boolean(d.revokedAt);
                  const isExpired = new Date(d.expiresAt) < new Date();
                  return (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3">
                        {d.manager?.firstName} {d.manager?.lastName}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-800">
                        {d.delegate?.firstName} {d.delegate?.lastName}
                      </td>
                      <td className="py-2.5 px-3">{new Date(d.startsAt).toLocaleDateString()}</td>
                      <td className="py-2.5 px-3">{new Date(d.expiresAt).toLocaleDateString()}</td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isRevoked
                              ? 'bg-slate-100 text-slate-600'
                              : isExpired
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {isRevoked ? 'REVOKED' : isExpired ? 'EXPIRED' : 'ACTIVE'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {!isRevoked && !isExpired && (
                          <button
                            onClick={() => handleRevokeDelegation(d.id)}
                            className="text-red-600 hover:text-red-800 p-1"
                            title="Revoke Delegation"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No delegations recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

