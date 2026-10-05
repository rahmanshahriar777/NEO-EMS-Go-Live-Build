import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import * as dotenv from 'dotenv';
import {
  QUEUE_NAMES,
  MAINTENANCE_QUEUE,
  DEFAULT_JOB_OPTIONS,
} from '@ems/shared';
import { processPayroll } from './processors/payroll.processor.js';
import { processNotification, registerChannelHook } from './processors/notification.processor.js';
import { sendEmailChannelHook } from './processors/email.processor.js';
// NOTE (go-live hardening, worker 2): the AI queue consumer was REMOVED.
// apps/worker/src/processors/ai.processor.ts was real code but unreachable:
// no API flow ever called QueueService.enqueueAi() (the API's AI path is
// synchronous via AiOrchestratorService), so the consumer idled forever.
// Decision: DELETE the dead processor rather than wire a producer with no
// consumer of its results. If an async AI flow is needed later, the typed
// producer (QueueService.enqueueAi), the queue name, and the AiJobPayload
// contract in @ems/shared all remain; re-adding a consumer is mechanical.
import { processMaintenance } from './processors/maintenance.processor.js';
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

  // Phases 2-3: repeatable jobs — nightly absence marking, retention purge,
  // and (once worker 3 registers its runner) scheduled reports.
  await setupRepeatableJobs(queues);

  const workers = [
    new Worker(QUEUE_NAMES.payroll, processPayroll, { connection, concurrency: 1 }),
    new Worker(QUEUE_NAMES.notifications, processNotification, { connection, concurrency: 5 }),
    // No AI queue consumer: the AI processor was unreachable dead code —
    // see the note on the removed import above.
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

  const shutdown = async (signal: string) => {
    log.info('worker.shutdown', { signal });
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
