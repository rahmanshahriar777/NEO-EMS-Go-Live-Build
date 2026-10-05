/**
 * Leave-request form validation (go-live hardening, Phase 3 item 7).
 *
 * Kept as a pure, UI-free helper so it is unit-testable without rendering the
 * page (CSS imports in page files cannot run under vitest). The react-hook-
 * form leave form (`components/leaves/leave-request-form.tsx`) delegates to
 * this; the rules mirror what the API enforces (required fields, end >=
 * start) so a client-side rejection always matches a server-side one —
 * behaviour is preserved, only the error surfaces earlier.
 */
export interface LeaveFormValues {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string;
}

/**
 * Returns the first human-readable validation problem, or `null` when the
 * values are submittable. Dates are ISO `yyyy-mm-dd` strings, so lexicographic
 * comparison is chronological.
 */
export function validateLeaveRequest(values: LeaveFormValues): string | null {
  if (!values.leaveTypeId || values.leaveTypeId.trim() === '') {
    return 'Choose a leave category.';
  }
  if (!values.startDate) {
    return 'Choose a start date.';
  }
  if (!values.endDate) {
    return 'Choose an end date.';
  }
  if (values.endDate < values.startDate) {
    return 'The end date cannot be before the start date.';
  }
  if (!values.reason || values.reason.trim() === '') {
    return 'Provide a reason for manager review.';
  }
  return null;
}
