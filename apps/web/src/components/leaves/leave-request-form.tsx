'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { X } from 'lucide-react';
import { api } from '../../lib/api-client';
import { LeaveType } from '../../lib/queries';
import { LeaveFormValues, validateLeaveRequest } from '../../lib/leave-validation';
import { useFocusTrap } from '../../hooks/use-focus-trap';

/**
 * Leave request form (go-live hardening, Phase 3 item 7).
 *
 * Converted from hand-rolled useState to react-hook-form: uncontrolled inputs
 * (no re-render per keystroke), declarative validation via
 * validateLeaveRequest, and isSubmitting for the pending state. On success the
 * parent invalidates the leaves query so the new request appears immediately.
 */
export function LeaveRequestForm({
  types,
  onClose,
  onSubmitted,
}: {
  types: LeaveType[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, { isActive: true, onEscape: onClose });

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<LeaveFormValues>({
    defaultValues: { leaveTypeId: '', startDate: '', endDate: '', reason: '' },
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Default the category to the first leave type once they load.
  useEffect(() => {
    if (types.length > 0 && !getValues('leaveTypeId')) {
      setValue('leaveTypeId', types[0].id);
    }
  }, [types, getValues, setValue]);

  const onSubmit = async (values: LeaveFormValues) => {
    setSubmitError(null);
    try {
      await api.post('/leave-requests', values);
      onSubmitted();
    } catch (err: any) {
      // Keep the modal open and show the error inline; the request was not created.
      setSubmitError(err?.message || 'Failed to submit leave request.');
    }
  };

  return (
    <div className="leave-modal-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="leave-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-modal-title"
      >
        <div className="leave-modal-header">
          <h3 className="leave-modal-title" id="leave-modal-title">
            Submit Leave Request
          </h3>
          <button onClick={onClose} className="leave-modal-close" aria-label="Close leave request dialog">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="leave-form-group">
            <label htmlFor="leave-category" className="leave-form-label">
              Leave Category
            </label>
            <select
              id="leave-category"
              className="leave-form-select"
              {...register('leaveTypeId', { required: 'Choose a leave category.' })}
              aria-invalid={errors.leaveTypeId ? 'true' : undefined}
              aria-describedby={errors.leaveTypeId ? 'leave-category-error' : undefined}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (Max {t.defaultDaysPerYear}d)
                </option>
              ))}
            </select>
            {errors.leaveTypeId && (
              <p id="leave-category-error" role="alert" className="leave-form-error">
                {errors.leaveTypeId.message}
              </p>
            )}
          </div>

          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}
            className="leave-form-group"
          >
            <div>
              <label htmlFor="leave-start-date" className="leave-form-label">
                Start Date
              </label>
              <input
                id="leave-start-date"
                type="date"
                className="leave-form-input"
                style={{ fontFamily: 'var(--leave-font-mono)' }}
                {...register('startDate', { required: 'Choose a start date.' })}
                aria-invalid={errors.startDate ? 'true' : undefined}
                aria-describedby={errors.startDate ? 'leave-start-date-error' : undefined}
              />
              {errors.startDate && (
                <p id="leave-start-date-error" role="alert" className="leave-form-error">
                  {errors.startDate.message}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="leave-end-date" className="leave-form-label">
                End Date
              </label>
              <input
                id="leave-end-date"
                type="date"
                className="leave-form-input"
                style={{ fontFamily: 'var(--leave-font-mono)' }}
                {...register('endDate', {
                  required: 'Choose an end date.',
                  validate: (v: string) => {
                    const problem = validateLeaveRequest({ ...getValues(), endDate: v });
                    return problem === 'The end date cannot be before the start date.' ? problem : true;
                  },
                })}
                aria-invalid={errors.endDate ? 'true' : undefined}
                aria-describedby={errors.endDate ? 'leave-end-date-error' : undefined}
              />
              {errors.endDate && (
                <p id="leave-end-date-error" role="alert" className="leave-form-error">
                  {errors.endDate.message}
                </p>
              )}
            </div>
          </div>

          <div className="leave-form-group">
            <label htmlFor="leave-reason" className="leave-form-label">
              Reason &amp; Context
            </label>
            <textarea
              id="leave-reason"
              rows={3}
              placeholder="Provide context for manager review and workload handover..."
              className="leave-form-textarea"
              {...register('reason', { required: 'Provide a reason for manager review.' })}
              aria-invalid={errors.reason ? 'true' : undefined}
              aria-describedby={errors.reason ? 'leave-reason-error' : undefined}
            />
            {errors.reason && (
              <p id="leave-reason-error" role="alert" className="leave-form-error">
                {errors.reason.message}
              </p>
            )}
          </div>

          <div className="leave-form-actions">
            {submitError && (
              <div
                role="alert"
                style={{
                  flexBasis: '100%',
                  marginBottom: '8px',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: 'rgba(244, 63, 94, 0.08)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  color: '#f43f5e',
                  fontSize: '12.5px',
                }}
              >
                {submitError}
              </div>
            )}
            <button type="button" onClick={onClose} className="leave-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className="leave-btn-primary">
              {isSubmitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
