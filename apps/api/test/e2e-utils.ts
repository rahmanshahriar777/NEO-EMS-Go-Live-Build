/**
 * E2E harness utilities.
 *
 * Infrastructure contract:
 * - The suite talks to a REAL Postgres (and optionally Redis) — no mocks.
 * - The database is located via `E2E_DATABASE_URL` (preferred) or
 *   `DATABASE_URL`. The TCP reachability check below is synchronous so the
 *   availability decision can be made at spec-collection time; when the DB
 *   is unreachable every e2e spec degrades to a single passing "skipped"
 *   test instead of failing on infrastructure.
 * - testcontainers is NOT used: it is not installed in this repo and there
 *   is no container runtime in the test environment. See test/README.md for
 *   the documented manual/CI approach (scratch database + migrated schema).
 */
import { spawnSync } from 'child_process';
import { URL } from 'url';

export interface DbTarget {
  host: string;
  port: number;
  url: string;
}

/** Resolve the database target from the environment, or null when unset. */
export function resolveDbTarget(): DbTarget | null {
  const url = process.env.E2E_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: Number(parsed.port) || 5432,
      url,
    };
  } catch {
    return null;
  }
}

/**
 * Synchronous TCP reachability probe (child node process, bounded timeout).
 * Returns true only when a TCP connection to host:port succeeds.
 */
export function tcpReachable(host: string, port: number, timeoutMs = 2000): boolean {
  const probe = `
    const s = require('net').connect({ host: process.argv[1], port: Number(process.argv[2]) });
    s.on('connect', () => process.exit(0));
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), ${timeoutMs}).unref();
  `;
  try {
    const res = spawnSync(process.execPath, ['-e', probe, host, String(port)], {
      timeout: timeoutMs + 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Collection-time availability check. Every e2e spec calls this once at the
 * top of the file:
 *
 *   const db = e2eDbOrSkip('my suite');
 *   (db.available ? describe : describe.skip)('my suite', () => { ... });
 *
 * When unavailable, the suite still registers a single passing test that
 * records WHY it was skipped, so CI shows intent rather than silence.
 */
export function e2eDbOrSkip(suiteName: string): {
  available: boolean;
  target: DbTarget | null;
  skipReason: string;
  registerSkip: () => void;
} {
  const target = resolveDbTarget();
  let skipReason: string;
  let available = false;
  if (!target) {
    skipReason =
      'no database configured — set E2E_DATABASE_URL (or DATABASE_URL) to run e2e';
  } else if (!tcpReachable(target.host, target.port)) {
    skipReason = `database at ${target.host}:${target.port} unreachable — start Postgres (see test/README.md)`;
  } else {
    available = true;
    skipReason = '';
  }
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e:${suiteName}] SKIPPED: ${skipReason}`);
  }
  return {
    available,
    target,
    skipReason,
    registerSkip: () => {
      it(`skips gracefully: ${skipReason}`, () => {
        expect(true).toBe(true);
      });
    },
  };
}
