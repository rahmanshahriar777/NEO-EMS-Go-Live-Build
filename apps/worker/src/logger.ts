/**
 * Minimal structured JSON logger for the worker.
 *
 * Every line is a single JSON object so log aggregators (Cloud Logging,
 * Loki, Datadog) can parse it without grok patterns. Loud by design:
 * failures must be impossible to miss.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

function emit(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: 'ems-worker',
    level,
    event,
    ...fields,
  });
  if (level === 'error' || level === 'fatal') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
  fatal: (event: string, fields: Record<string, unknown> = {}) => emit('fatal', event, fields),
};

/**
 * ALERTING HOOK — wire before production.
 *
 * Currently emits a loud structured fatal log, which is the most this repo
 * can honestly do without alerting credentials. To page a human, replace the
 * body with a POST to PagerDuty/Opsgenie (events API) or a Slack webhook,
 * using credentials from the secret manager — never hardcoded here.
 */
export function alertOps(message: string, context: Record<string, unknown> = {}): void {
  log.fatal('ops.alert', { message, ...context });
  const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (alertWebhookUrl) {
    fetch(alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 *CRITICAL WORKER ALERT*: ${message}\n\`\`\`${JSON.stringify(context, null, 2)}\`\`\``,
      }),
    }).catch((err: any) => {
      log.error('ops.alert.dispatch_failed', { error: err?.message });
    });
  }
}
