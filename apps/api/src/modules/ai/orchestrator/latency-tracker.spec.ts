import { LatencyTracker } from './latency-tracker';

describe('LatencyTracker', () => {
  it('returns 0 for percentiles and error rate when empty', () => {
    const t = new LatencyTracker();
    expect(t.getP50()).toBe(0);
    expect(t.getP95()).toBe(0);
    expect(t.getErrorRate()).toBe(0);
    expect(t.getLastSuccess()).toBeNull();
    expect(t.getLastError()).toBeNull();
  });

  it('computes p50/p95 over the recorded window', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 100; i++) t.recordLatency(i, true);
    // Window keeps the last 50 samples: [51..100].
    // p50 -> index floor(0.5*50)=25 -> 76; p95 -> index floor(0.95*50)=47 -> 98.
    expect(t.getP50()).toBe(76);
    expect(t.getP95()).toBe(98);
  });

  it('keeps only the last 50 samples', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 60; i++) t.recordLatency(i, true);
    // window holds 11..60; p50 of that window is the 26th value = 36
    expect(t.getP50()).toBe(36);
  });

  it('computes the error rate over the outcome window', () => {
    const t = new LatencyTracker();
    t.recordLatency(10, true);
    t.recordLatency(20, true);
    t.recordLatency(30, false, 'boom');
    expect(t.getLastError()).toBe('boom');
    t.recordLatency(40, false);
    expect(t.getErrorRate()).toBe(0.5);
    expect(t.getLastError()).toBe('Unknown error');
    expect(t.getLastSuccess()).not.toBeNull();
  });

  it('defaults the error message when none is given', () => {
    const t = new LatencyTracker();
    t.recordLatency(5, false);
    expect(t.getLastError()).toBe('Unknown error');
  });
});
