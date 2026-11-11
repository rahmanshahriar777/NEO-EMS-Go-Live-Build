import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import {
  AuditAction,
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportStatus,
  UploadSessionStatus,
} from '@ems/shared';
import {
  MediaValidationError,
  computeExpectedEncryptedSize,
  createOoxmlMacroScannerTransform,
  detectFieldMediaMime,
  sanitizeFileName,
} from '@ems/storage';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { AuditService } from '../../../core/audit/audit.service';
import { QueueService } from '../../../core/queues/queue.service';
import { CreateUploadSessionDto } from '../dto/field-report.dto';
import { FieldReportViewer } from './field-report-access.service';
import { FieldReportsStorageService } from './field-reports-storage.service';

@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly queueService: QueueService,
    private readonly storage: FieldReportsStorageService,
  ) {}

  private getLimits() {
    return {
      maxFileSizeBytes: this.configService.get<number>('fieldReports.maxFileSizeBytes', 52_428_800),
      maxFilesPerRevision: this.configService.get<number>('fieldReports.maxFilesPerRevision', 20),
      maxTotalBytesPerRevision: this.configService.get<number>(
        'fieldReports.maxTotalBytesPerRevision',
        262_144_000,
      ),
      chunkSizeBytes: this.configService.get<number>('fieldReports.chunkSizeBytes', 5_242_880),
      allowedMimeTypes: this.configService.get<string[]>('fieldReports.allowedMimeTypes', []),
    };
  }

  private async assertEditableDraftRevision(
    reportId: string,
    revisionId: string,
    viewer: FieldReportViewer,
  ) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisionId);
    const revision = await this.prisma.fieldReportRevision.findFirst({
      where: isUuid
        ? {
            id: revisionId,
            reportId,
            report: { deletedAt: null },
          }
        : {
            revisionNumber: parseInt(revisionId, 10) || 1,
            reportId,
            report: { deletedAt: null },
          },
      include: {
        report: {
          select: { id: true, employeeId: true, createdByUserId: true, status: true },
        },
      },
    });
    if (!revision) {
      throw new NotFoundException({
        message: 'Field report revision not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }
    const isOwner =
      revision.report.createdByUserId === viewer.userId ||
      (viewer.employeeId && revision.report.employeeId === viewer.employeeId);
    if (!isOwner) {
      throw new ForbiddenException({
        message: 'Only the report author can upload attachments.',
        error: 'FORBIDDEN',
      });
    }
    if (revision.status !== FieldReportStatus.DRAFT || revision.lockedAt !== null) {
      throw new ConflictException({
        message: 'Submitted or locked field report revisions cannot accept new attachments.',
        error: 'REVISION_IMMUTABLE',
      });
    }
    return revision;
  }

  async createSession(
    reportId: string,
    revisionId: string,
    dto: CreateUploadSessionDto,
    viewer: FieldReportViewer,
  ) {
    const limits = this.getLimits();
    const revision = await this.assertEditableDraftRevision(reportId, revisionId, viewer);
    const actualRevisionId = revision.id;

    const originalFileName = (dto.originalFileName || (dto as any).fileName || 'attachment').trim();
    const claimedMimeType = (dto.claimedMimeType || (dto as any).mimeType || 'application/octet-stream').trim();
    const declaredSizeBytes = Number(dto.declaredSizeBytes ?? (dto as any).byteSize ?? 0);
    const declaredSha256 = dto.declaredSha256 || (dto as any).clientSha256;

    if (declaredSizeBytes > limits.maxFileSizeBytes) {
      throw new PayloadTooLargeException({
        message: `File size ${declaredSizeBytes} exceeds per-file limit of ${limits.maxFileSizeBytes} bytes.`,
        error: 'FILE_TOO_LARGE',
      });
    }

    if (
      limits.allowedMimeTypes.length > 0 &&
      !limits.allowedMimeTypes.includes(claimedMimeType) &&
      claimedMimeType !== 'application/octet-stream'
    ) {
      throw new UnsupportedMediaTypeException({
        message: `Claimed file type '${claimedMimeType}' is not allowed for field reporting.`,
        error: 'UNSUPPORTED_MIME_TYPE',
      });
    }

    // Idempotency return when retrying the same offline capture UUID on the report.
    if (dto.clientCaptureId) {
      const existingAtt = await this.prisma.fieldReportAttachment.findFirst({
        where: { reportId, clientCaptureId: dto.clientCaptureId, deletedAt: null },
        include: { derivatives: true },
      });
      if (existingAtt) {
        return {
          alreadyCompleted: true,
          attachmentId: existingAtt.id,
          attachment: existingAtt,
        };
      }
      const existingOpen = await this.prisma.fieldReportUploadSession.findFirst({
        where: {
          reportId,
          revisionId: actualRevisionId,
          clientCaptureId: dto.clientCaptureId,
          status: UploadSessionStatus.OPEN,
          expiresAt: { gt: new Date() },
        },
      });
      if (existingOpen) {
        return {
          alreadyCompleted: false,
          sessionId: existingOpen.id,
          chunkSizeBytes: existingOpen.chunkSizeBytes,
          totalChunks: existingOpen.totalChunks,
          uploadedChunks: existingOpen.uploadedChunks,
          expiresAt: existingOpen.expiresAt.toISOString(),
        };
      }
    }

    const existingLinks = await this.prisma.fieldReportRevisionAttachment.findMany({
      where: {
        revisionId: actualRevisionId,
        attachment: { deletedAt: null },
      },
      include: { attachment: { select: { fileSizeBytes: true } } },
    });

    if (existingLinks.length >= limits.maxFilesPerRevision) {
      throw new PayloadTooLargeException({
        message: `Maximum of ${limits.maxFilesPerRevision} files per revision exceeded.`,
        error: 'REPORT_QUOTA_EXCEEDED',
      });
    }

    const currentBytes = existingLinks.reduce(
      (sum, l) => sum + (l.attachment?.fileSizeBytes ?? 0),
      0,
    );
    if (currentBytes + declaredSizeBytes > limits.maxTotalBytesPerRevision) {
      throw new PayloadTooLargeException({
        message: `Report revision total size exceeds limit of ${limits.maxTotalBytesPerRevision} bytes.`,
        error: 'REPORT_QUOTA_EXCEEDED',
      });
    }

    const sessionId = randomUUID();
    const chunkSizeBytes = limits.chunkSizeBytes;
    const totalChunks = Math.ceil(declaredSizeBytes / chunkSizeBytes);
    const { wrapped } = this.storage.cipher.createWrappedStagingKey();
    const stagingKeyPrefix = `field-reports/staging/sessions/${sessionId}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.prisma.fieldReportUploadSession.create({
      data: {
        id: sessionId,
        reportId,
        revisionId: actualRevisionId,
        uploadedByUserId: viewer.userId,
        employeeId: revision.report.employeeId,
        clientCaptureId: dto.clientCaptureId ?? null,
        originalFileName: sanitizeFileName(originalFileName),
        claimedMimeType,
        declaredSizeBytes,
        declaredSha256: declaredSha256?.toLowerCase() ?? null,
        chunkSizeBytes,
        totalChunks,
        uploadedChunks: [],
        stagingKeyPrefix,
        stagingKeyEnc: wrapped,
        status: UploadSessionStatus.OPEN,
        expiresAt,
      },
    });

    return {
      alreadyCompleted: false,
      sessionId,
      chunkSizeBytes,
      totalChunks,
      uploadedChunks: [],
      expiresAt: expiresAt.toISOString(),
    };
  }

  async readRawChunkBody(req: Request, maxAllowedBytes: number): Promise<Buffer> {
    const anyReq = req as any;
    if (Buffer.isBuffer(anyReq.rawChunkBuffer)) {
      if (anyReq.rawChunkBuffer.length > maxAllowedBytes) {
        throw new PayloadTooLargeException({
          message: `Chunk exceeds allowed size (${maxAllowedBytes} bytes).`,
          error: 'FILE_TOO_LARGE',
        });
      }
      return anyReq.rawChunkBuffer;
    }
    if (Buffer.isBuffer(anyReq.body)) {
      if (anyReq.body.length > maxAllowedBytes) {
        throw new PayloadTooLargeException({
          message: `Chunk exceeds allowed size (${maxAllowedBytes} bytes).`,
          error: 'FILE_TOO_LARGE',
        });
      }
      return anyReq.body;
    }

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };

      req.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxAllowedBytes) {
          fail(
            new PayloadTooLargeException({
              message: `Chunk exceeded maximum chunk limit (${maxAllowedBytes} bytes).`,
              error: 'FILE_TOO_LARGE',
            }),
          );
          return;
        }
        chunks.push(buf);
      });

      req.on('error', (err) => {
        fail(new BadRequestException(`Chunk stream failed: ${err.message}`));
      });

      req.on('aborted', () => {
        fail(new BadRequestException('Client aborted chunk upload'));
      });

      req.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async uploadChunk(
    sessionId: string,
    index: number,
    chunkBuffer: Buffer,
    viewer: FieldReportViewer,
    headerChunkSha256?: string,
  ) {
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException({
        message: 'Chunk index must be a non-negative integer.',
        error: 'INVALID_CHUNK_INDEX',
      });
    }
    if (!chunkBuffer || chunkBuffer.length === 0) {
      throw new BadRequestException({
        message: 'Uploaded chunk cannot be empty.',
        error: 'INVALID_MEDIA_CONTENT',
      });
    }

    const session = await this.prisma.fieldReportUploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException({
        message: 'Upload session not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }
    if (session.uploadedByUserId !== viewer.userId) {
      throw new ForbiddenException({
        message: 'Upload session belongs to another user.',
        error: 'FORBIDDEN',
      });
    }
    if (session.status !== UploadSessionStatus.OPEN || session.expiresAt <= new Date()) {
      throw new ConflictException({
        message: 'Upload session is no longer open.',
        error: 'REVISION_IMMUTABLE',
      });
    }
    if (index >= session.totalChunks) {
      throw new BadRequestException({
        message: `Chunk index ${index} out of bounds for session (${session.totalChunks} chunks).`,
        error: 'INVALID_CHUNK_INDEX',
      });
    }

    const expectedLen =
      index < session.totalChunks - 1
        ? session.chunkSizeBytes
        : session.declaredSizeBytes - index * session.chunkSizeBytes;
    if (chunkBuffer.length !== expectedLen) {
      throw new BadRequestException({
        message: `Chunk ${index} length mismatch: expected ${expectedLen} bytes, received ${chunkBuffer.length}.`,
        error: 'INVALID_MEDIA_CONTENT',
      });
    }

    if (headerChunkSha256) {
      const actualSha = createHash('sha256').update(chunkBuffer).digest('hex');
      if (actualSha.toLowerCase() !== headerChunkSha256.trim().toLowerCase()) {
        throw new ConflictException({
          message: `Chunk ${index} SHA-256 verification failed.`,
          error: 'PART_CHECKSUM_MISMATCH',
        });
      }
    }

    const stagingKey = this.stagingPartKey(session.stagingKeyPrefix, index);
    const stagingKeyBuf = this.storage.cipher.unwrapStagingKey(session.stagingKeyEnc);
    const encPart = this.storage.cipher.encryptStagingPart(
      chunkBuffer,
      stagingKeyBuf,
      sessionId,
      index,
    );
    await this.storage.vault.putBuffer(stagingKey, encPart);

    const updatedRows = await this.prisma.$queryRaw<Array<{ uploadedChunks: number[] }>>`
      UPDATE "field_report_upload_sessions"
      SET "uploadedChunks" = (
        SELECT ARRAY(
          SELECT DISTINCT unnest("uploadedChunks" || ARRAY[${index}]::integer[])
          ORDER BY 1
        )
      ),
      "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${sessionId} AND "status" = 'OPEN'
      RETURNING "uploadedChunks"
    `;

    const uploadedChunks = updatedRows[0]?.uploadedChunks ?? [];
    return {
      sessionId,
      chunkIndex: index,
      uploadedChunks,
      totalChunks: session.totalChunks,
    };
  }

  async completeSession(
    sessionId: string,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const limits = this.getLimits();
    const claimed = await this.prisma.fieldReportUploadSession.updateMany({
      where: {
        id: sessionId,
        uploadedByUserId: viewer.userId,
        status: UploadSessionStatus.OPEN,
      },
      data: { status: UploadSessionStatus.COMPLETING },
    });

    const session = await this.prisma.fieldReportUploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException({
        message: 'Upload session not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }
    if (session.uploadedByUserId !== viewer.userId) {
      throw new ForbiddenException({
        message: 'Upload session belongs to another user.',
        error: 'FORBIDDEN',
      });
    }
    if (claimed.count === 0) {
      if (session.status === UploadSessionStatus.COMPLETED) {
        const existingAtt = await this.prisma.fieldReportAttachment.findFirst({
          where: {
            reportId: session.reportId,
            clientCaptureId: session.clientCaptureId,
            deletedAt: null,
          },
        });
        if (existingAtt) {
          return {
            id: existingAtt.id,
            attachmentId: existingAtt.id,
            mediaKind: existingAtt.mediaKind,
            mimeType: existingAtt.mimeType,
            fileSizeBytes: existingAtt.fileSizeBytes,
            checksumSha256: existingAtt.checksumSha256,
            scanStatus: existingAtt.scanStatus,
            processingStatus: existingAtt.processingStatus,
          };
        }
      }
      throw new ConflictException({
        message: `Upload session is in state '${session.status}' and cannot be completed.`,
        error: 'REVISION_IMMUTABLE',
      });
    }

    const resetToOpen = async () => {
      await this.prisma.fieldReportUploadSession.updateMany({
        where: { id: sessionId, status: UploadSessionStatus.COMPLETING },
        data: { status: UploadSessionStatus.OPEN },
      });
    };

    try {
      const revision = await this.assertEditableDraftRevision(
        session.reportId,
        session.revisionId,
        viewer,
      );

      const expectedChunks = Array.from({ length: session.totalChunks }, (_, i) => i);
      const uploadedSet = new Set(session.uploadedChunks);
      const missing = expectedChunks.filter((i) => !uploadedSet.has(i));
      if (missing.length > 0) {
        await resetToOpen();
        throw new UnprocessableEntityException({
          message: `Upload incomplete; missing chunk(s): ${missing.slice(0, 10).join(', ')}`,
          error: 'INCOMPLETE_UPLOAD',
          details: { missingChunks: missing },
        });
      }

      const existingLinks = await this.prisma.fieldReportRevisionAttachment.findMany({
        where: { revisionId: session.revisionId, attachment: { deletedAt: null } },
        include: { attachment: { select: { fileSizeBytes: true } } },
      });
      if (existingLinks.length >= limits.maxFilesPerRevision) {
        throw new PayloadTooLargeException({
          message: `Maximum of ${limits.maxFilesPerRevision} files per revision exceeded.`,
          error: 'REPORT_QUOTA_EXCEEDED',
        });
      }
      const existingBytes = existingLinks.reduce(
        (s, l) => s + (l.attachment?.fileSizeBytes ?? 0),
        0,
      );
      if (existingBytes + session.declaredSizeBytes > limits.maxTotalBytesPerRevision) {
        throw new PayloadTooLargeException({
          message: `Report revision total size exceeds limit of ${limits.maxTotalBytesPerRevision} bytes.`,
          error: 'REPORT_QUOTA_EXCEEDED',
        });
      }

      const stagingKeyBuf = this.storage.cipher.unwrapStagingKey(session.stagingKeyEnc);
      const attachmentId = randomUUID();
      const safeName = sanitizeFileName(session.originalFileName);
      const originalStorageKey = `field-reports/originals/${session.reportId}/${attachmentId}.enc`;
      const chunkSizeBytes = 262_144;
      const expectedEncSize = computeExpectedEncryptedSize(
        session.declaredSizeBytes,
        chunkSizeBytes,
      );

      const { transform: encryptTransform, iv, keyId } =
        this.storage.cipher.createEncryptTransform({
          storageKey: originalStorageKey,
          objectUuid: attachmentId,
          plaintextSizeBytes: session.declaredSizeBytes,
          chunkSizeBytes,
        });

      const plainFeed = new PassThrough();
      const macroScanner = createOoxmlMacroScannerTransform();
      const sha256 = createHash('sha256');
      let head8192 = Buffer.alloc(0);
      let actualTotalBytes = 0;

      const uploadPromise = this.storage.vault.putStream(
        originalStorageKey,
        plainFeed.pipe(macroScanner.transform).pipe(encryptTransform),
        expectedEncSize,
      );

      try {
        for (let i = 0; i < session.totalChunks; i++) {
          const partKey = this.stagingPartKey(session.stagingKeyPrefix, i);
          const encPart = await this.storage.vault.getBuffer(partKey);
          const plainPart = this.storage.cipher.decryptStagingPart(
            encPart,
            stagingKeyBuf,
            sessionId,
            i,
          );
          actualTotalBytes += plainPart.length;
          sha256.update(plainPart);
          if (head8192.length < 8192) {
            const take = 8192 - head8192.length;
            head8192 = Buffer.concat([head8192, plainPart.subarray(0, take)]);
          }

          if (!plainFeed.write(plainPart)) {
            await new Promise<void>((resolve) => plainFeed.once('drain', resolve));
          }
        }
        plainFeed.end();
        await uploadPromise;
      } catch (err) {
        plainFeed.destroy();
        await this.safeRemoveObject(originalStorageKey);
        throw err;
      }

      const actualSha256 = sha256.digest('hex');
      if (actualTotalBytes !== session.declaredSizeBytes) {
        await this.safeRemoveObject(originalStorageKey);
        await this.markSessionAbortedAndCleanup(session);
        throw new BadRequestException({
          message: `Assembled file size ${actualTotalBytes} != declared ${session.declaredSizeBytes}.`,
          error: 'INVALID_MEDIA_CONTENT',
        });
      }

      if (session.declaredSha256 && actualSha256 !== session.declaredSha256) {
        await this.safeRemoveObject(originalStorageKey);
        await this.markSessionAbortedAndCleanup(session);
        throw new ConflictException({
          message: 'Assembled file SHA-256 mismatch against declared checksum.',
          error: 'PART_CHECKSUM_MISMATCH',
        });
      }

      let detected;
      try {
        detected = await detectFieldMediaMime(
          head8192,
          session.claimedMimeType,
          limits.allowedMimeTypes,
          { hasVbaMacro: macroScanner.hasMacro() },
        );
      } catch (err) {
        await this.safeRemoveObject(originalStorageKey);
        await this.markSessionAbortedAndCleanup(session);
        if (err instanceof MediaValidationError) {
          const status =
            err.code === 'INVALID_MEDIA_CONTENT'
              ? HttpStatus.BAD_REQUEST
              : HttpStatus.UNSUPPORTED_MEDIA_TYPE;
          if (status === HttpStatus.BAD_REQUEST) {
            throw new BadRequestException({ message: err.message, error: err.code });
          }
          throw new UnsupportedMediaTypeException({ message: err.message, error: err.code });
        }
        throw err;
      }

      const mediaKind =
        detected.mediaKind === 'IMAGE' ? FieldMediaKind.IMAGE : FieldMediaKind.DOCUMENT;

      const createdAttachment = await this.prisma.$transaction(async (tx) => {
        const revCheck = await tx.fieldReportRevision.findUnique({
          where: { id: revision.id },
          select: { lockedAt: true, status: true, revisionNumber: true },
        });
        if (!revCheck || revCheck.lockedAt !== null || revCheck.status !== FieldReportStatus.DRAFT) {
          throw new ConflictException({
            message: 'Revision was locked before upload finished.',
            error: 'REVISION_IMMUTABLE',
          });
        }

        const att = await tx.fieldReportAttachment.create({
          data: {
            id: attachmentId,
            reportId: session.reportId,
            uploadedByUserId: viewer.userId,
            employeeId: session.employeeId,
            clientCaptureId: session.clientCaptureId,
            mediaKind,
            originalFileName: safeName,
            mimeType: detected.mimeType,
            fileSizeBytes: actualTotalBytes,
            checksumSha256: actualSha256,
            storageKey: originalStorageKey,
            encrypted: true,
            encryptionScheme: 'CHUNKED_GCM_V1',
            iv,
            keyId,
            chunkSizeBytes,
            scanStatus:
              !this.configService.get<boolean>('fieldReports.malwareScanEnabled', true) ||
              process.env.ALLOW_INSECURE_DEV_SCANNER === 'true'
                ? FieldMediaScanStatus.CLEAN
                : FieldMediaScanStatus.PENDING_SCAN,
            processingStatus: FieldMediaProcessingStatus.PENDING,
          },
        });

        await tx.fieldReportRevisionAttachment.create({
          data: {
            revisionId: revision.id,
            attachmentId: att.id,
            sortOrder: existingLinks.length,
            addedInRevisionNumber: revCheck.revisionNumber,
          },
        });

        await tx.fieldReportUploadSession.update({
          where: { id: sessionId },
          data: { status: UploadSessionStatus.COMPLETED },
        });

        await this.auditService.log(
          {
            actorId: viewer.userId,
            actorEmail: viewer.email,
            action: AuditAction.CREATE,
            entityType: 'FIELD_REPORT_ATTACHMENT',
            entityId: att.id,
            afterState: {
              reportId: session.reportId,
              revisionId: revision.id,
              mediaKind: att.mediaKind,
              mimeType: att.mimeType,
              fileSizeBytes: att.fileSizeBytes,
              checksumSha256: att.checksumSha256,
              scanStatus: att.scanStatus,
            },
            ipAddress,
          },
          tx as any,
        );

        return att;
      });

      // Best-effort cleanup of encrypted staging parts now that canonical vault object exists.
      await this.cleanupStagingParts(session.stagingKeyPrefix, session.totalChunks);

      const isBypassed =
        !this.configService.get<boolean>('fieldReports.malwareScanEnabled', true) ||
        process.env.ALLOW_INSECURE_DEV_SCANNER === 'true';

      if (isBypassed) {
        if (createdAttachment.mediaKind === FieldMediaKind.IMAGE) {
          await this.queueService.enqueueFieldMediaTransform(
            createdAttachment.id,
            session.reportId,
          );
        }
      } else {
        // Enqueue fail-closed malware scan job; worker will follow up with derivative generation for IMAGEs.
        await this.queueService.enqueueFieldMediaScan(
          createdAttachment.id,
          session.reportId,
        );
      }

      return {
        id: createdAttachment.id,
        attachmentId: createdAttachment.id,
        mediaKind: createdAttachment.mediaKind,
        mimeType: createdAttachment.mimeType,
        fileSizeBytes: createdAttachment.fileSizeBytes,
        checksumSha256: createdAttachment.checksumSha256,
        scanStatus: createdAttachment.scanStatus,
        processingStatus: createdAttachment.processingStatus,
      };
    } catch (err) {
      // Revert back to OPEN only if failure was recoverable / transient (e.g. missing chunks / MinIO hiccup).
      const current = await this.prisma.fieldReportUploadSession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (current?.status === UploadSessionStatus.COMPLETING) {
        await resetToOpen();
      }
      throw err;
    }
  }

  async abortSession(sessionId: string, viewer: FieldReportViewer) {
    const session = await this.prisma.fieldReportUploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException({
        message: 'Upload session not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }
    if (session.uploadedByUserId !== viewer.userId) {
      throw new ForbiddenException({
        message: 'Upload session belongs to another user.',
        error: 'FORBIDDEN',
      });
    }
    if (session.status === UploadSessionStatus.COMPLETED) {
      throw new ConflictException({
        message: 'Completed upload session cannot be aborted.',
        error: 'REVISION_IMMUTABLE',
      });
    }
    await this.markSessionAbortedAndCleanup(session);
    return { sessionId, status: UploadSessionStatus.ABORTED };
  }

  async removeAttachmentFromRevision(
    reportId: string,
    revisionId: string,
    attachmentId: string,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const revision = await this.assertEditableDraftRevision(reportId, revisionId, viewer);
    const actualRevisionId = revision.id;

    const link = await this.prisma.fieldReportRevisionAttachment.findUnique({
      where: { revisionId_attachmentId: { revisionId: actualRevisionId, attachmentId } },
      include: { attachment: true },
    });
    if (!link) {
      throw new NotFoundException({
        message: 'Attachment is not linked to this draft revision.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const otherLinksCount = await this.prisma.fieldReportRevisionAttachment.count({
      where: { attachmentId, NOT: { revisionId: actualRevisionId } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.fieldReportRevisionAttachment.delete({
        where: { revisionId_attachmentId: { revisionId: actualRevisionId, attachmentId } },
      });

      if (otherLinksCount === 0) {
        await tx.fieldReportAttachment.update({
          where: { id: attachmentId },
          data: { deletedAt: new Date() },
        });
      }

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.DELETE,
          entityType: 'FIELD_REPORT_ATTACHMENT',
          entityId: attachmentId,
          afterState: {
            reportId,
            revisionId,
            softDeletedAttachment: otherLinksCount === 0,
          },
          ipAddress,
        },
        tx as any,
      );
    });

    return { removed: true, attachmentId };
  }

  private stagingPartKey(prefix: string, index: number): string {
    return `${prefix}/part-${String(index).padStart(5, '0')}`;
  }

  private async safeRemoveObject(key: string): Promise<void> {
    try {
      await this.storage.vault.removeObject(key);
    } catch (e: any) {
      this.logger.warn(`Failed to remove MinIO object '${key}': ${e?.message}`);
    }
  }

  private async cleanupStagingParts(prefix: string, totalChunks: number): Promise<void> {
    try {
      const keys = Array.from({ length: totalChunks }, (_, i) =>
        this.stagingPartKey(prefix, i),
      );
      await this.storage.vault.removeObjects(keys);
    } catch (e: any) {
      this.logger.warn(`Failed to clean staging prefix '${prefix}': ${e?.message}`);
    }
  }

  private async markSessionAbortedAndCleanup(session: {
    id: string;
    stagingKeyPrefix: string;
    totalChunks: number;
  }) {
    await this.prisma.fieldReportUploadSession.update({
      where: { id: session.id },
      data: { status: UploadSessionStatus.ABORTED },
    });
    await this.cleanupStagingParts(session.stagingKeyPrefix, session.totalChunks);
  }
}

