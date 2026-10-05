/**
 * Framework-free structured JSON logger (Phase 1 observability).
 *
 * Every line is a single JSON object: log aggregators (Cloud Logging, Loki,
 * Datadog) parse it without grok patterns. The worker already ships an
 * equivalent (apps/worker/src/logger.ts) and keeps it — this factory exists
 * so NEW code (and the API, when its owner wires JSON logging) shares one
 * field convention: ts, service, level, event, requestId, …fields.
 *
 * Levels follow the existing worker convention: debug/info/warn/error/fatal.
 * `LOG_LEVEL` env var controls the floor (default: info; debug only when
 * explicitly set — never in production).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

function levelFloor(): LogLevel {
  const raw = (typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined) ?? 'info';
  const normalized = raw.toLowerCase() as LogLevel;
  return normalized in LEVEL_ORDER ? normalized : 'info';
}

export interface Logger {
  debug: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
  fatal: (event: string, fields?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

/**
 * Create a JSON logger for a service. `bindings` (e.g. { requestId }) are
 * merged into every line — use `child({ requestId })` per request/job.
 */
export function createLogger(service: string, bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[levelFloor()]) {
      return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service,
      level,
      event,
      ...bindings,
      ...fields,
    });
    if (level === 'error' || level === 'fatal') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    fatal: (event, fields) => emit('fatal', event, fields),
    child: (extra) => createLogger(service, { ...bindings, ...extra }),
  };
}
