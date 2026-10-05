/**
 * Automated accessibility checks (go-live hardening, task 12).
 *
 * axe-core runs against the new skeleton components: the loading states that
 * replaced the dashboard/employees/leaves/documents spinners must introduce
 * no violations, and shimmer blocks must stay aria-hidden so screen readers
 * hear the page's single aria-live announcement instead of per-block noise.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { SkeletonTable, SkeletonStatCard, SkeletonCardGrid, SkeletonText } from '../skeleton';

describe('skeleton screens (automated a11y)', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <main>
        <h1>Loading</h1>
        <SkeletonStatCard />
        <SkeletonTable rows={3} columns={4} />
        <SkeletonCardGrid cards={2} />
        <SkeletonText width="60%" />
      </main>,
    );
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('marks shimmer blocks aria-hidden so screen readers are not spammed', () => {
    const { getAllByTestId } = render(<SkeletonTable rows={2} columns={3} />);
    const blocks = getAllByTestId('skeleton');
    expect(blocks.length).toBeGreaterThan(0);
    for (const el of blocks) {
      expect(el).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
