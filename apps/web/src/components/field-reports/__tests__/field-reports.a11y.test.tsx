import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import React from 'react';
import { OutboxRunner } from '../outbox-runner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

describe('Field Reports Accessibility (axe-core)', () => {
  it('renders field reporting components with zero axe violations', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <main>
          <h1>Field Report Review</h1>
          <div role="region" aria-label="Attachments">
            <button type="button" aria-label="Download Resized Photo">
              Download Resized
            </button>
            <button type="button" aria-label="Download Original Photo">
              Download Original
            </button>
          </div>
          <OutboxRunner />
        </main>
      </QueryClientProvider>,
    );

    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

