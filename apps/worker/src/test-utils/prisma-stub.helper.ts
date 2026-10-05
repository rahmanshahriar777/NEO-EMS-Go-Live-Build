/**
 * Test helper: stub Prisma delegate methods.
 *
 * Prisma model delegates are Proxies whose `getOwnPropertyDescriptor` trap
 * does not reflect the real methods, so `node:test`'s `t.mock.method()` rejects
 * them ("The argument 'methodName' must be a method. Received undefined").
 * Plain assignment DOES work through the Proxy's `set` trap, and the delegate
 * object identity is stable, so patch-then-restore via assignment is safe.
 *
 * Usage:
 *   const create = stubPrisma(prisma.notification, 'create', async (args) => ({ id: 'n-1' }), t);
 *   create.calls[0][0] // first call's first argument
 */
import type { TestContext } from 'node:test';

export interface PrismaStub {
  (...args: any[]): any;
  /** Captured call arguments, one entry per call. */
  calls: any[][];
}

export function stubPrisma(
  delegate: any,
  method: string,
  impl: (...args: any[]) => unknown,
  t: TestContext,
): PrismaStub {
  const original = delegate[method];
  const calls: any[][] = [];
  const stub = function (this: unknown, ...args: any[]) {
    calls.push(args);
    return impl.apply(this, args);
  };
  (stub as any).calls = calls;
  delegate[method] = stub;
  t.after(() => {
    delegate[method] = original;
  });
  return stub as PrismaStub;
}
