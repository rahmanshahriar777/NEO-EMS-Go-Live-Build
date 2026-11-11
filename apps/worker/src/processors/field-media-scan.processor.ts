import { Job, Queue } from 'bullmq';
import { prisma } from '@ems/database';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '@ems/shared';
import {
  ChunkedCipherService,
  ClamAvScanner,
  MalwareScanner,
  MinioVaultClient,
  NoopMalwareScanner,
  loadEncryptionKeyRingFromEnv,
  loadMinioConfigFromEnv,
} from '@ems/storage';
import { alertOps, log } from '../logger.js';
import { appendWorkerAuditLog } from '../lib/worker-audit.js';
import {
  processGenerateDerivatives,
  type FieldMediaTransformDeps,
} from './field-media-transform.processor.js';

export interface FieldMediaScanDeps extends FieldMediaTransformDeps {
  scanner?: MalwareScanner;
  fieldMediaQueue?: Pick<Queue, 'add'>;
  notificationsQueue?: Pick<Queue, 'add'>;
  auditWriter?: typeof appendWorkerAuditLog;
}

let cachedVault: MinioVaultClient | null = null;
let cachedCipher: ChunkedCipherService | null = null;
let sharedFieldMediaQueue: Queue | null = null;
let sharedNotificationsQueue: Queue | null = null;

export function setFieldMediaQueues(queues: {
  fieldMediaQueue?: Queue;
  notificationsQueue?: Queue;
}): void {
  if (queues.fieldMediaQueue) sharedFieldMediaQueue = queues.fieldMediaQueue;
  if (queues.notificationsQueue) sharedNotificationsQueue = queues.notificationsQueue;
}

function getDefaultVault(): MinioVaultClient {
  if (!cachedVault) {
    cachedVault = new MinioVaultClient(loadMinioConfigFromEnv());
  }
  return cachedVault;
}

function getDefaultCipher(): ChunkedCipherService {
  if (!cachedCipher) {
    cachedCipher = new ChunkedCipherService(loadEncryptionKeyRingFromEnv());
  }
  return cachedCipher;
}

function buildQueueConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

function getFieldMediaQueue(): Pick<Queue, 'add'> {
  if (!sharedFieldMediaQueue) {
    sharedFieldMediaQueue = new Queue(QUEUE_NAMES.fieldMedia, {
      connection: buildQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return sharedFieldMediaQueue;
}

function getNotificationsQueue(): Pick<Queue, 'add'> {
  if (!sharedNotificationsQueue) {
    sharedNotificationsQueue = new Queue(QUEUE_NAMES.notifications, {
      connection: buildQueueConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return sharedNotificationsQueue;
}

export function resolveFieldMediaScanner(
  env: NodeJS.ProcessEnv = process.env,
): MalwareScanner {
  const isProd = env.NODE_ENV === 'production';
  const enabledEnv = env.FIELD_REPORT_MALWARE_SCAN_ENABLED;
  const allowInsecureDev = env.ALLOW_INSECURE_DEV_SCANNER === 'true';

  if (enabledEnv === 'false' || allowInsecureDev) {
    if (isProd && !allowInsecureDev) {
      throw new Error(
        'FIELD_REPORT_MALWARE_SCAN_ENABLED=false is forbidden in production: malware scanning is fail-closed.',
      );
    }
    log.warn('field-media.scan.disabled-dev', {
      note: 'Using NoopMalwareScanner because FIELD_REPORT_MALWARE_SCAN_ENABLED=false or ALLOW_INSECURE_DEV_SCANNER=true',
    });
    return new NoopMalwareScanner();
  }

  const host = env.CLAMAV_HOST || (isProd ? '' : 'localhost');
  if (!host) {
    throw new Error('CLAMAV_HOST must be configured when FIELD_REPORT_MALWARE_SCAN_ENABLED is active');
  }
  const port = parseInt(env.CLAMAV_PORT || '3310', 10);
  const timeoutMs = parseInt(env.CLAMAV_TIMEOUT_MS || '90000', 10);
  return new ClamAvScanner(host, port, timeoutMs);
}

async function notifyThreatDetected(
  db: typeof prisma,
  notifQueue: Pick<Queue, 'add'>,
  attachment: any,
  threats: string[],
  correlationId?: string,
) {
  const report = attachment.report;
  const recipientMap = new Map<string, { userId: string; email?: string; name?: string }>();

  if (report?.createdByUserId) {
    recipientMap.set(report.createdByUserId, {
      userId: report.createdByUserId,
      email: report.employee?.email,
      name: report.employee
        ? `${report.employee.firstName} ${report.employee.lastName}`
        : undefined,
    });
  }
  if (report?.employee?.userId) {
    recipientMap.set(report.employee.userId, {
      userId: report.employee.userId,
      email: report.employee.email,
      name: `${report.employee.firstName} ${report.employee.lastName}`,
    });
  }

  const hrAdmins = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { name: 'HR_ADMIN' } } },
    },
    select: {
      id: true,
      email: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });

  for (const hr of hrAdmins) {
    if (!recipientMap.has(hr.id)) {
      recipientMap.set(hr.id, {
        userId: hr.id,
        email: hr.email,
        name: hr.employee ? `${hr.employee.firstName} ${hr.employee.lastName}` : undefined,
      });
    }
  }

  const threatList = threats.length > 0 ? threats.join(', ') : 'MALWARE_DETECTED';
  for (const target of recipientMap.values()) {
    await notifQueue
      .add(
        'send-notification',
        {
          userId: target.userId,
          channel: 'email',
          template: 'field-report-threat-detected',
          data: {
            email: target.email,
            name: target.name,
            reportNumber: report?.reportNumber,
            fileName: attachment.originalFileName,
            threats,
            title: `Malware detected in upload (${report?.reportNumber || attachment.reportId})`,
            message: `Attachment "${attachment.originalFileName}" failed malware scanning (${threatList}) and was quarantined and deleted.`,
            linkUrl: `/field-reports/${attachment.reportId}`,
          },
          correlationId: correlationId ?? `fr-threat-${attachment.id}`,
        },
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: `fr-threat-${attachment.id}-${target.userId}`,
        },
      )
      .catch((err: any) => {
        log.error('field-media.threat-notify.failed', {
          attachmentId: attachment.id,
          targetUserId: target.userId,
          error: err?.message,
        });
      });
  }
}

export async function processScanAttachment(
  job: Job<{ attachmentId: string; reportId: string; correlationId?: string }>,
  deps: FieldMediaScanDeps = {},
) {
  const { attachmentId, reportId, correlationId } = job.data;
  const db = deps.db ?? prisma;
  const vault = deps.vault ?? getDefaultVault();
  const cipher = deps.cipher ?? getDefaultCipher();
  const scanner = deps.scanner ?? resolveFieldMediaScanner();
  const mediaQueue = deps.fieldMediaQueue ?? getFieldMediaQueue();
  const notifQueue = deps.notificationsQueue ?? getNotificationsQueue();
  const writeAudit = deps.auditWriter ?? appendWorkerAuditLog;

  const attachment = await db.fieldReportAttachment.findFirst({
    where: { id: attachmentId, deletedAt: null },
    include: {
      report: {
        include: {
          employee: {
            select: {
              id: true,
              userId: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });

  if (!attachment) {
    log.warn('field-media.scan.missing', { attachmentId, reportId, correlationId });
    return { skipped: true, reason: 'attachment-not-found' };
  }

  if (attachment.scanStatus === 'INFECTED') {
    log.warn('field-media.scan.already-infected', { attachmentId, reportId, correlationId });
    return { attachmentId, scanStatus: 'INFECTED', alreadyHandled: true };
  }

  if (attachment.scanStatus === 'CLEAN') {
    if (attachment.mediaKind === 'IMAGE' && attachment.processingStatus === 'PENDING') {
      await mediaQueue.add(
        'generate-derivatives',
        { attachmentId: attachment.id, reportId: attachment.reportId, correlationId },
        { ...DEFAULT_JOB_OPTIONS, jobId: `field-transform-${attachment.id}` },
      );
    }
    return { attachmentId, scanStatus: 'CLEAN', alreadyHandled: true };
  }

  log.info('field-media.scan.start', {
    jobId: job.id,
    attachmentId,
    reportId,
    scanner: scanner.name,
    correlationId,
  });

  const encryptedStream = await vault.getStream(attachment.storageKey);
  const decryptTransform = cipher.createDecryptTransform({
    storageKey: attachment.storageKey,
    objectUuid: attachment.id,
    iv: attachment.iv,
    keyId: attachment.keyId,
    plaintextSizeBytes: attachment.fileSizeBytes,
    chunkSizeBytes: attachment.chunkSizeBytes,
  });

  encryptedStream.on('error', (err) => {
    if (!decryptTransform.destroyed) decryptTransform.destroy(err);
  });
  decryptTransform.once('close', () => {
    if (!encryptedStream.destroyed) encryptedStream.destroy();
  });

  const plainReadable = encryptedStream.pipe(decryptTransform);
  const scanResult = await scanner.scanStream(plainReadable, attachment.originalFileName);

  const now = new Date();
  if (!scanResult.clean) {
    // Quarantine immediately: delete encrypted object from MinIO, mark INFECTED, never transform!
    await vault.removeObject(attachment.storageKey).catch((err: any) => {
      log.error('field-media.quarantine.remove-failed', {
        attachmentId,
        storageKey: attachment.storageKey,
        error: err?.message,
      });
    });

    await db.fieldReportAttachment.update({
      where: { id: attachment.id },
      data: {
        scanStatus: 'INFECTED',
        scannerName: scanResult.scanner,
        scanThreats: scanResult.threats,
        scannedAt: now,
        processingStatus: 'SKIPPED',
        processingErrorCode: 'MALWARE_DETECTED',
      },
    });

    await writeAudit(
      {
        actorId: attachment.uploadedByUserId,
        action: 'CREATE' as any,
        entityType: 'FIELD_REPORT_MALWARE_SCAN',
        entityId: attachment.id,
        afterState: {
          reportId: attachment.reportId,
          clean: false,
          scanner: scanResult.scanner,
          threats: scanResult.threats,
          checksumSha256: attachment.checksumSha256,
          quarantined: true,
        },
      },
      db,
    );

    alertOps('Malware detected in uploaded field report attachment — quarantined and deleted', {
      attachmentId: attachment.id,
      reportId: attachment.reportId,
      fileName: attachment.originalFileName,
      threats: scanResult.threats,
      scanner: scanResult.scanner,
      correlationId,
    });

    await notifyThreatDetected(db, notifQueue, attachment, scanResult.threats, correlationId);

    return {
      attachmentId: attachment.id,
      scanStatus: 'INFECTED',
      threats: scanResult.threats,
    };
  }

  // Clean scan: transition to CLEAN and schedule derivative processing for IMAGE attachments only.
  await db.fieldReportAttachment.update({
    where: { id: attachment.id },
    data: {
      scanStatus: 'CLEAN',
      scannerName: scanResult.scanner,
      scanThreats: [],
      scannedAt: now,
      processingStatus: attachment.mediaKind === 'IMAGE' ? 'PENDING' : 'SKIPPED',
      processingErrorCode: null,
    },
  });

  await writeAudit(
    {
      actorId: attachment.uploadedByUserId,
      action: 'CREATE' as any,
      entityType: 'FIELD_REPORT_MALWARE_SCAN',
      entityId: attachment.id,
      afterState: {
        reportId: attachment.reportId,
        clean: true,
        scanner: scanResult.scanner,
        checksumSha256: attachment.checksumSha256,
      },
    },
    db,
  );

  if (attachment.mediaKind === 'IMAGE') {
    await mediaQueue.add(
      'generate-derivatives',
      {
        attachmentId: attachment.id,
        reportId: attachment.reportId,
        correlationId: correlationId ?? `fr-deriv-${attachment.id}`,
      },
      {
        ...DEFAULT_JOB_OPTIONS,
        jobId: `field-transform-${attachment.id}`,
      },
    );
  }

  log.info('field-media.scan.clean', {
    jobId: job.id,
    attachmentId: attachment.id,
    reportId,
    mediaKind: attachment.mediaKind,
    scanner: scanResult.scanner,
    correlationId,
  });

  return {
    attachmentId: attachment.id,
    scanStatus: 'CLEAN',
    mediaKind: attachment.mediaKind,
  };
}

export async function processFieldMediaJob(
  job: Job<{ attachmentId: string; reportId: string; correlationId?: string }>,
  deps: FieldMediaScanDeps = {},
) {
  if (job.name === 'generate-derivatives') {
    return processGenerateDerivatives(job, deps);
  }
  return processScanAttachment(job, deps);
}
