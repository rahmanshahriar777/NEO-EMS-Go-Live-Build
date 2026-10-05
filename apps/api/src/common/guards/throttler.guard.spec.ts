import { AppThrottlerGuard } from './throttler.guard';

describe('AppThrottlerGuard', () => {
  // ThrottlerGuard's constructor needs (options, storage, reflector);
  // getTracker only reads the request, so stubs suffice.
  const guard = new AppThrottlerGuard(
    { throttlers: [{ ttl: 60000, limit: 100 }] } as any,
    { increment: jest.fn() } as any,
    { getAllAndOverride: jest.fn() } as any,
  );
  // getTracker is protected — exercise it through a structural cast.
  const tracker = (req: Record<string, any>) =>
    (guard as unknown as { getTracker: (r: Record<string, any>) => Promise<string> }).getTracker(req);

  it('keys authenticated requests by userId:ip', async () => {
    await expect(tracker({ ip: '1.2.3.4', user: { sub: 'user-1' } })).resolves.toBe('user-1:1.2.3.4');
  });

  it('falls back to ip alone for anonymous requests', async () => {
    await expect(tracker({ ip: '5.6.7.8' })).resolves.toBe('5.6.7.8');
    await expect(tracker({ ip: '5.6.7.8', user: {} })).resolves.toBe('5.6.7.8');
  });

  it('uses "unknown" when no ip is present', async () => {
    await expect(tracker({})).resolves.toBe('unknown');
    await expect(tracker({ user: { sub: 'u9' } })).resolves.toBe('u9:unknown');
  });
});
