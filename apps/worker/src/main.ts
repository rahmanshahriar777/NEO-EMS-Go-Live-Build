import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import {
  QUEUE_NAMES,
  MAINTENANCE_QUEUE,
  DEFAULT_JOB_OPTIONS,
  RETENTION_SIGNOFF_ENV,
  isRetentionSignedOff,
  metrics,
} from '@ems/shared';
import * as http from 'http';
import { processPayroll } from './processors/payroll.processor.js';
import { processNotification, registerChannelHook } from './processors/notification.processor.js';
import { sendEmailChannelHook } from './processors/email.processor.js';
import { processAi } from './processors/ai.processor.js';
import { processMaintenance } from './processors/maintenance.processor.js';
import { setLeaveAccrualRedis } from './processors/leave-accrual.processor.js';
import { setupRepeatableJobs } from './schedule.js';
import { log, alertOps } from './logger.js';

dotenv.config();

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
const redisPassword = process.env.REDIS_PASSWORD || undefined;

/** A job is "stuck" if it has been actively processing for over an hour. */
const STUCK_AFTER_MS = 60 * 60 * 1000;

const MAX_ATTEMPTS = DEFAULT_JOB_OPTIONS.attempts;

log.info('worker.boot', { redisHost, redisPort });

const connection = new Redis({
  host: redisHost,
  port: redisPort,
  password: redisPassword,
  maxRetriesPerRequest: null,
  lazyConnect: true,
  enableOfflineQueue: false,
});

/**
 * Move an exhausted job to a dead-letter queue instead of letting BullMQ drop
 * it. DLQ name: `<queue>.dlq`. DLQ entries keep the original payload plus
 * failure metadata so an operator can inspect and replay them.
 */
async function moveToDlq(queues: Record<string, Queue>, queueName: string, job: Job, err: Error) {
  const dlqName = `${queueName}.dlq`;
  const dlq =
    queues[dlqName] ??
    (queues[dlqName] = new Queue(dlqName, {
      connection,
      defaultJobOptions: { attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 },
    }));

  await dlq.add('dlq', {
    ...job.data,
    _dlq: {
      originalQueue: queueName,
      originalJobId: job.id,
      failedAt: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
      error: err.message,
    },
  });

  alertOps('Job exhausted all retries and was moved to the dead-letter queue', {
    queue: queueName,
    jobId: job.id,
    dlq: dlqName,
    error: err.message,
  });
}

/**
 * Startup recovery: requeue jobs that were actively processing for >1h when
 * this worker (or a previous one) died. Prevents silent loss after crashes
 * and deploys. Waiting/delayed jobs are left alone — backoff delays are
 * intentional.
 */
async function recoverStuckJobs(queueName: string, queue: Queue): Promise<void> {
  const active = await queue.getJobs(['active']);
  let recovered = 0;
  for (const job of active) {
    const startedAt = job.processedOn ?? job.timestamp;
    const stuckForMs = Date.now() - startedAt;
    if (stuckForMs > STUCK_AFTER_MS) {
      log.warn('worker.recovery.requeue', {
        queue: queueName,
        jobId: job.id,
        stuckForMs,
      });
      await job.retry();
      recovered++;
    }
  }
  log.info('worker.recovery.done', { queue: queueName, activeChecked: active.length, recovered });
}

async function bootstrap() {
  try {
    await connection.connect();
    log.info('worker.redis.connected', { redisHost, redisPort });
  } catch (err: any) {
    log.warn('worker.redis.unreachable', { error: err.message });
  }

  // Queue handles (producer-side defaults + recovery/DLQ tooling). Job-level
  // attempts/backoff live in DEFAULT_JOB_OPTIONS from @ems/shared; the API
  // producer must pass the same options when enqueueing.
  const queueNames = [...Object.values(QUEUE_NAMES), MAINTENANCE_QUEUE];
  const queues: Record<string, Queue> = {};
  for (const name of queueNames) {
    queues[name] = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  }

  for (const [name, queue] of Object.entries(queues)) {
    await recoverStuckJobs(name, queue);
  }

  // Phase 1 B2: email channel for the notification fan-out. Sends via the
  // shared nodemailer provider (@ems/shared mailer — single implementation
  // used by both the API and the worker).
  registerChannelHook('email', sendEmailChannelHook);

  // HIGH #4: the leave-accrual processor reuses this shared connection.
  // Its old module-local client used lazyConnect:true and never connected,
  // so every monthly accrual run failed into the DLQ.
  setLeaveAccrualRedis(connection);

  // Retention gate state (HIGH #3, go-live hardening): the scheduled AI-log
  // purge is DRY-RUN BY DEFAULT — it counts and logs but never deletes.
  // Real deletes require counsel sign-off (GDPR_RETENTION_SIGNED_OFF=true)
  // AND an explicit dryRun:false on the job. Same gate and semantics as the
  // API's GDPR multi-entity purge (one gate, @ems/shared).
  const retentionSignedOff = isRetentionSignedOff();
  log.info('worker.retention.gate', {
    signedOff: retentionSignedOff,
    retentionPurgeMode: retentionSignedOff
      ? 'ARMED — jobs with explicit dryRun:false will LIVE DELETE'
      : `DRY-RUN — no rows deleted (set ${RETENTION_SIGNOFF_ENV}=true after counsel sign-off to arm)`,
  });

  // Phases 2-3: repeatable jobs — nightly absence marking, retention purge,
  // and (once worker 3 registers its runner) scheduled reports.
  await setupRepeatableJobs(queues);

  const workers = [
    new Worker(QUEUE_NAMES.payroll, processPayroll, { connection, concurrency: 1 }),
    new Worker(QUEUE_NAMES.notifications, processNotification, { connection, concurrency: 5 }),
    new Worker(QUEUE_NAMES.ai, processAi, { connection, concurrency: 2 }),
    new Worker(MAINTENANCE_QUEUE, processMaintenance, { connection, concurrency: 1 }),
  ];

  for (const w of workers) {
    w.on('completed', (job) => {
      log.info('worker.job.completed', { queue: w.name, jobId: job.id });
    });
    w.on('failed', async (job, err) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      // Loud structured failure log — impossible to miss in the aggregator.
      log.error('worker.job.failed', {
        queue: w.name,
        jobId: job?.id,
        attemptsMade,
        maxAttempts: MAX_ATTEMPTS,
        error: err.message,
        stack: err.stack,
      });
      if (job && attemptsMade >= MAX_ATTEMPTS) {
        try {
          await moveToDlq(queues, w.name, job, err);
        } catch (dlqErr: any) {
          alertOps('Failed to move exhausted job to DLQ — manual intervention required', {
            queue: w.name,
            jobId: job.id,
            error: dlqErr?.message,
          });
        }
      }
    });
    w.on('error', (err) => {
      log.error('worker.error', { queue: w.name, error: err.message });
    });
  }

  log.info('worker.listening', { queues: queueNames });

  // Heartbeat file for Kubernetes exec liveness probe
  const heartbeatPath = process.env.WORKER_HEARTBEAT_PATH || '/tmp/worker-heartbeat';
  const touchHeartbeat = async () => {
    try {
      if (connection.status === 'ready' || connection.status === 'connect') {
        await connection.ping();
      }
      await fs.promises.writeFile(heartbeatPath, Date.now().toString(), 'utf8');
    } catch (e: any) {
      log.warn('worker.heartbeat.failed', { error: e?.message });
    }
  };
  await touchHeartbeat();
  const heartbeatInterval = setInterval(touchHeartbeat, 10_000);
  if (typeof (heartbeatInterval as any).unref === 'function') (heartbeatInterval as any).unref();

  // Prometheus HTTP metrics & health server (exposes /metrics on port 9100)
  const metricsPort = parseInt(process.env.WORKER_METRICS_PORT || '9100', 10);
  const metricsServer = http.createServer((req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics.renderPrometheus());
    } else if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  metricsServer.listen(metricsPort, () => {
    log.info('worker.metrics.listening', { port: metricsPort });
  });
  if (typeof (metricsServer as any).unref === 'function') (metricsServer as any).unref();

  const shutdown = async (signal: string) => {
    log.info('worker.shutdown', { signal });
    clearInterval(heartbeatInterval);
    metricsServer.close();
    try {
      await fs.promises.unlink(heartbeatPath);
    } catch {}
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await connection.quit();
    log.info('worker.shutdown.done', {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((e) => {
  log.fatal('worker.bootstrap.failed', { error: e?.message, stack: e?.stack });
  process.exit(1);
});
