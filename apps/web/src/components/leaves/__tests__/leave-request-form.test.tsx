/**
 * Leave-request form tests (go-live hardening, task 12 — leave approval flow).
 *
 * Renders the real react-hook-form component: empty submission surfaces the
 * required-field errors inline (role="alert"), and the dialog carries no
 * axe violations. Submission itself is not exercised here — the API client
 * needs a live backend — so this stays honest about what it covers.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { LeaveRequestForm } from '../leave-request-form';

const TYPES = [
  { id: 'annual', name: 'Annual Leave', defaultDaysPerYear: 25 },
  { id: 'sick', name: 'Sick Leave', defaultDaysPerYear: 10 },
];

function renderForm() {
  return render(
    <LeaveRequestForm types={TYPES} onClose={vi.fn()} onSubmitted={vi.fn()} />,
  );
}

describe('LeaveRequestForm', () => {
  it('is a labelled dialog', () => {
    renderForm();
    expect(screen.getByRole('dialog', { name: 'Submit Leave Request' })).toBeInTheDocument();
  });

  it('shows required-field errors on empty submit', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText('Choose a start date.')).toBeInTheDocument();
      expect(screen.getByText('Choose an end date.')).toBeInTheDocument();
      expect(screen.getByText('Provide a reason for manager review.')).toBeInTheDocument();
    });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects an end date before the start date', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Start Date'), {
      target: { value: '2026-10-14' },
    });
    fireEvent.change(screen.getByLabelText('End Date'), {
      target: { value: '2026-10-12' },
    });
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'Need the time off.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      expect(screen.getByText('The end date cannot be before the start date.')).toBeInTheDocument();
    });
  });

  it('has no axe violations', async () => {
    const { container } = renderForm();
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
