'use client';

import React, { useState, useEffect } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api-client';

/**
 * Fields accepted by the employee API (CreateEmployeeDto) plus the Phase 2
 * extended-profile fields (worker 1 — schema extension pending). Unknown
 * fields are stripped server-side by the validation pipe, so including the
 * extended fields is forward-compatible and never breaks the current API.
 */
export interface EmployeeFormValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  gender: string;
  address: string;
  departmentId: string;
  designationId: string;
  managerId: string;
  joiningDate: string;
  contractEndDate: string;
  status: string;
  workLocation: string;
  profileSummary: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
}

export const EMPTY_EMPLOYEE_FORM: EmployeeFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  gender: '',
  address: '',
  departmentId: '',
  designationId: '',
  managerId: '',
  joiningDate: '',
  contractEndDate: '',
  status: 'FULL_TIME',
  workLocation: '',
  profileSummary: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  emergencyContactRelation: '',
};

export function employeeToForm(e: any): EmployeeFormValues {
  const dateOnly = (v: any) => (v ? String(v).split('T')[0] : '');
  return {
    firstName: e.firstName || '',
    lastName: e.lastName || '',
    email: e.email || '',
    phone: e.phone || '',
    dateOfBirth: dateOnly(e.dateOfBirth),
    gender: e.gender || '',
    address: e.address || '',
    departmentId: e.departmentId || e.department?.id || '',
    designationId: e.designationId || e.designation?.id || '',
    managerId: e.managerId || e.manager?.id || '',
    joiningDate: dateOnly(e.joiningDate),
    contractEndDate: dateOnly(e.contractEndDate),
    status: e.status || 'FULL_TIME',
    workLocation: e.workLocation || '',
    profileSummary: e.profileSummary || '',
    emergencyContactName: e.emergencyContactName || e.emergencyContact?.name || '',
    emergencyContactPhone: e.emergencyContactPhone || e.emergencyContact?.phone || '',
    emergencyContactRelation: e.emergencyContactRelation || e.emergencyContact?.relation || '',
  };
}

/**
 * Build the payload for create (full) or edit (partial: only changed fields).
 * Empty optional strings are omitted so PATCH never blanks a field the user
 * didn't touch.
 */
export function buildEmployeePayload(
  values: EmployeeFormValues,
  baseline?: EmployeeFormValues,
): Record<string, any> {
  const payload: Record<string, any> = {};
  const consider = (key: keyof EmployeeFormValues, required = false) => {
    const v = values[key].trim();
    if (required) {
      payload[key] = v;
      return;
    }
    if (!baseline) {
      if (v) payload[key] = v;
      return;
    }
    // Partial update: send only what changed (and only non-empty values;
    // clearing a field is done via the profile page's explicit clear buttons).
    if (v !== baseline[key].trim() && v) payload[key] = v;
  };

  consider('firstName', true);
  consider('lastName', true);
  if (!baseline) consider('email', true); // email is immutable on update
  consider('phone');
  consider('dateOfBirth');
  consider('gender');
  consider('address');
  consider('departmentId');
  consider('designationId');
  consider('managerId');
  consider('joiningDate');
  consider('contractEndDate');
  consider('status', true);
  consider('workLocation');
  consider('profileSummary');
  consider('emergencyContactName');
  consider('emergencyContactPhone');
  consider('emergencyContactRelation');
  return payload;
}

interface Option {
  id: string;
  name?: string;
  title?: string;
}

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  initial: EmployeeFormValues;
  onClose: () => void;
  onSubmit: (payload: Record<string, any>) => Promise<void>;
}

const inputCls =
  'w-full px-3 py-2 border border-[#e2dfda] rounded-[10px] text-[13px] text-[#1a1816] bg-white focus:outline-none focus:border-[#2c5f4a] focus:ring-2 focus:ring-[#2c5f4a]/15';
const labelCls = 'block text-[12px] font-semibold text-[#4a4642] mb-1.5';

export const EmployeeFormModal: React.FC<Props> = ({ open, mode, initial, onClose, onSubmit }) => {
  const [values, setValues] = useState<EmployeeFormValues>(initial);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [designations, setDesignations] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(initial);
      setError(null);
      // Reference data for the selects; failures degrade to free-form fields.
      api
        .get<any>('/departments', { params: { limit: 100 } })
        .then((r) => setDepartments(Array.isArray(r) ? r : r?.items || []))
        .catch(() => {});
      api
        .get<any>('/designations', { params: { limit: 100 } })
        .then((r) => setDesignations(Array.isArray(r) ? r : r?.items || []))
        .catch(() => {});
    }
  }, [open, initial]);

  if (!open) return null;

  const set = (k: keyof EmployeeFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = buildEmployeePayload(values, mode === 'edit' ? initial : undefined);
      await onSubmit(payload);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not save the employee.');
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof EmployeeFormValues,
    label: string,
    type = 'text',
    opts?: { required?: boolean; span?: boolean; placeholder?: string },
  ) => (
    <div className={opts?.span ? 'sm:col-span-2' : ''}>
      <label className={labelCls} htmlFor={`emp-${key}`}>
        {label}
        {opts?.required && <span className="text-rose-600"> *</span>}
      </label>
      <input
        id={`emp-${key}`}
        type={type}
        className={inputCls}
        value={values[key]}
        onChange={set(key)}
        required={opts?.required}
        placeholder={opts?.placeholder}
      />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? 'Create employee' : 'Edit employee'}
    >
      <div
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[16px] font-bold text-[#1a1816]">
            {mode === 'create' ? 'New employee' : 'Edit employee'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-slate-500 mb-5">
          {mode === 'create'
            ? 'Creates the employee record. Account access is granted separately via invitation.'
            : 'Only changed fields are sent (partial update). Role, status-email changes follow the manager field policy.'}
        </p>

        {error && (
          <div className="mb-4 rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-700" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {field('firstName', 'First name', 'text', { required: true })}
            {field('lastName', 'Last name', 'text', { required: true })}
            {mode === 'create' && field('email', 'Work email', 'email', { required: true, span: true })}
            {field('phone', 'Phone', 'tel')}
            {field('dateOfBirth', 'Date of birth', 'date')}
            <div>
              <label className={labelCls} htmlFor="emp-gender">Gender</label>
              <select id="emp-gender" className={inputCls} value={values.gender} onChange={set('gender')}>
                <option value="">Not specified</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
            {field('address', 'Address', 'text', { span: true })}
            <div>
              <label className={labelCls} htmlFor="emp-departmentId">Department</label>
              <select id="emp-departmentId" className={inputCls} value={values.departmentId} onChange={set('departmentId')}>
                <option value="">Unassigned</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="emp-designationId">Designation</label>
              <select id="emp-designationId" className={inputCls} value={values.designationId} onChange={set('designationId')}>
                <option value="">Unassigned</option>
                {designations.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="emp-status">Employment status</label>
              <select id="emp-status" className={inputCls} value={values.status} onChange={set('status')}>
                {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'PROBATION', 'INTERN', 'TERMINATED'].map((s) => (
                  <option key={s} value={s}>{s.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            {field('workLocation', 'Work location', 'text', { placeholder: 'e.g. London HQ, Floor 4 / Remote' })}
            {field('joiningDate', 'Joining date', 'date')}
            {field('contractEndDate', 'Contract end date', 'date')}
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="emp-profileSummary">Professional summary</label>
              <textarea
                id="emp-profileSummary"
                className={inputCls}
                rows={3}
                value={values.profileSummary}
                onChange={set('profileSummary')}
                maxLength={1000}
              />
            </div>
          </div>

          <h4 className="mt-6 mb-3 text-[13px] font-bold text-[#1a1816]">Emergency contact</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {field('emergencyContactName', 'Full name')}
            {field('emergencyContactPhone', 'Phone', 'tel')}
            {field('emergencyContactRelation', 'Relationship', 'text', { placeholder: 'e.g. Spouse' })}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-[#e2dfda] bg-white px-4 py-2 text-[13px] font-semibold text-[#4a4642] hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-[10px] bg-[#2c5f4a] px-5 py-2 text-[13px] font-semibold text-white hover:bg-[#24493a] disabled:opacity-60"
            >
              {busy && <RefreshCw className="w-4 h-4 animate-spin" />}
              {busy ? 'Saving…' : mode === 'create' ? 'Create employee' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
