import { MetricsController } from './metrics.controller';

/**
 * MetricsController is a thin guarded wrapper around the shared registry;
 * the @Roles(SUPER_ADMIN, HR_ADMIN) guard behaviour is covered by the guard
 * specs. This pins the render delegation and content contract.
 */
describe('MetricsController', () => {
  it('returns the Prometheus exposition text', () => {
    const controller = new MetricsController();

    const body = controller.scrape();

    expect(typeof body).toBe('string');
    // renderPrometheus always ends with a trailing newline (possibly the
    // only content when no metrics are registered yet).
    expect(body.endsWith('\n')).toBe(true);
  });
});
