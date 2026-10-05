import { describe, it, expect } from 'vitest';
import { validateLeaveRequest, LeaveFormValues } from '../leave-validation';

const valid: LeaveFormValues = {
  leaveTypeId: 'annual-id',
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  reason: 'Family wedding in Dhaka, handover notes attached.',
};

describe('validateLeaveRequest (leave approval flow)', () => {
  it('accepts a complete, well-formed request', () => {
    expect(validateLeaveRequest(valid)).toBeNull();
  });

  it('accepts a single-day request (start == end)', () => {
    expect(validateLeaveRequest({ ...valid, endDate: valid.startDate })).toBeNull();
  });

  it('rejects a missing leave category', () => {
    expect(validateLeaveRequest({ ...valid, leaveTypeId: '' })).toMatch(/category/i);
  });

  it('rejects missing dates', () => {
    expect(validateLeaveRequest({ ...valid, startDate: '' })).toMatch(/start date/i);
    expect(validateLeaveRequest({ ...valid, endDate: '' })).toMatch(/end date/i);
  });

  it('rejects an end date before the start date', () => {
    expect(
      validateLeaveRequest({ ...valid, startDate: '2026-10-14', endDate: '2026-10-12' }),
    ).toMatch(/before the start/i);
  });

  it('rejects a blank reason', () => {
    expect(validateLeaveRequest({ ...valid, reason: '   ' })).toMatch(/reason/i);
  });
});
