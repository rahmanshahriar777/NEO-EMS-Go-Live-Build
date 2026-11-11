import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PassThrough, Transform, type TransformCallback, pipeline } from 'node:stream';
import type { Request, Response } from 'express';
import archiver = require('archiver');
import {
  AuditAction,
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportDerivativeKind,
  FieldReportDownloadVariant,
} from '@ems/shared';
import { computeRangePlan, sanitizeFileName } from '@ems/storage';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { AuditService } from '../../../core/audit/audit.service';
import { RedisService } from '../../../core/redis/redis.service';
import {
  CreateDownloadGrantDto,
  CreateZipDownloadGrantDto,
  DownloadGrantResponseDto,
  RequestedDownloadVariant,
} from '../dto/field-report.dto';
import {
  FieldReportDownloadGrantPayload,
  resolveDownloadTokenSecret,
} from '../guards/download-grant.guard';
import { FieldReportAccessService, FieldReportViewer } from './field-report-access.service';
import { FieldReportPolicyService } from './field-report-policy.service';
import { FieldReportsStorageService } from './field-reports-storage.service';

interface ResolvedDownloadTarget {
  attachmentId: string;
  storageKey: string;
  objectUuid: string;
  iv: string;
  keyId: string;
  chunkSizeBytes: number;
  plaintextSizeBytes: number;
  expectedSha256: string;
  mimeType: string;
  fileName: string;
  variantServed: RequestedDownloadVariant;
  verifyFullSha256: boolean;
}

@Injectable()
export class DownloadGrantService {
  private readonly logger = new Logger(DownloadGrantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly redisService: RedisService,
    private readonly accessService: FieldReportAccessService,
    private readonly policyService: FieldReportPolicyService,
    private readonly storage: FieldReportsStorageService,
  ) {}

  private buildDerivativeFileName(
    originalFileName: string,
    variant: 'RESIZED' | 'PREVIEW' | 'THUMBNAIL',
  ): string {
    const clean = sanitizeFileName(originalFileName);
    const ext = extname(clean);
    const stem = ext ? clean.slice(0, clean.length - ext.length) : clean;
    if (variant === 'RESIZED') return `${stem}_resized.jpg`;
    if (variant === 'PREVIEW') return `${stem}_preview.webp`;
    return `${stem}_thumb.webp`;
  }

  private buildContentDisposition(disp: 'inline' | 'attachment', fileName: string): string {
    const asciiFallback = sanitizeFileName(fileName).replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(fileName).replace(
      /['()*!]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `${disp}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
  }

  private mapVariantToDerivativeKind(
    variant: 'RESIZED' | 'PREVIEW' | 'THUMBNAIL',
  ): FieldReportDerivativeKind {
    if (variant === 'THUMBNAIL') return FieldReportDerivativeKind.THUMBNAIL;
    if (variant === 'PREVIEW') return FieldReportDerivativeKind.WEB_PREVIEW;
    return FieldReportDerivativeKind.RESIZED_STANDARD;
  }

  private resolveAttachmentTarget(
    attachment: any,
    variant: RequestedDownloadVariant,
    canDownloadOriginal: boolean,
  ): ResolvedDownloadTarget {
    if (attachment.scanStatus === FieldMediaScanStatus.INFECTED) {
      throw new ForbiddenException({
        message: 'Infected attachments cannot be downloaded.',
        error: 'SCAN_INFECTED',
      });
    }
    if (attachment.scanStatus !== FieldMediaScanStatus.CLEAN) {
      throw new ConflictException({
        message: 'Attachment malware scan has not completed cleanly yet.',
        error: 'SCAN_PENDING',
        details: { attachmentId: attachment.id, scanStatus: attachment.scanStatus },
      });
    }

    if (attachment.mediaKind === FieldMediaKind.DOCUMENT) {
      if (variant !== 'ORIGINAL') {
        throw new BadRequestException({
          message: 'Documents do not have resized variants and must be downloaded as ORIGINAL.',
          error: 'DOCUMENTS_ORIGINAL_ONLY',
        });
      }
      return {
        attachmentId: attachment.id,
        storageKey: attachment.storageKey,
        objectUuid: attachment.id,
        iv: attachment.iv,
        keyId: attachment.keyId,
        chunkSizeBytes: attachment.chunkSizeBytes,
        plaintextSizeBytes: attachment.fileSizeBytes,
        expectedSha256: attachment.checksumSha256,
        mimeType: attachment.mimeType,
        fileName: sanitizeFileName(attachment.originalFileName),
        variantServed: 'ORIGINAL',
        verifyFullSha256: true,
      };
    }

    if (variant === 'ORIGINAL') {
      if (!canDownloadOriginal) {
        throw new ForbiddenException({
          message: 'Downloading Original full-resolution images is disabled by policy or role permissions.',
          error: 'ORIGINAL_DOWNLOAD_DISABLED_BY_POLICY',
        });
      }
      return {
        attachmentId: attachment.id,
        storageKey: attachment.storageKey,
        objectUuid: attachment.id,
        iv: attachment.iv,
        keyId: attachment.keyId,
        chunkSizeBytes: attachment.chunkSizeBytes,
        plaintextSizeBytes: attachment.fileSizeBytes,
        expectedSha256: attachment.checksumSha256,
        mimeType: attachment.mimeType,
        fileName: sanitizeFileName(attachment.originalFileName),
        variantServed: 'ORIGINAL',
        verifyFullSha256: true,
      };
    }

    const kind = this.mapVariantToDerivativeKind(variant);
    const derivative = Array.isArray(attachment.derivatives)
      ? attachment.derivatives.find((d: any) => d.kind === kind)
      : null;

    if (
      attachment.processingStatus !== FieldMediaProcessingStatus.READY ||
      !derivative
    ) {
      // Critical invariant: NEVER silently fall back to serving Original!
      throw new ConflictException({
        message: 'Resized image derivative is still processing and cannot be served yet.',
        error: 'DERIVATIVES_NOT_READY',
        details: {
          attachmentId: attachment.id,
          processingStatus: attachment.processingStatus,
          requestedKind: kind,
        },
      });
    }

    return {
      attachmentId: attachment.id,
      storageKey: derivative.storageKey,
      objectUuid: derivative.id,
      iv: derivative.iv,
      keyId: derivative.keyId,
      chunkSizeBytes: derivative.chunkSizeBytes,
      plaintextSizeBytes: derivative.fileSizeBytes,
      expectedSha256: derivative.checksumSha256,
      mimeType: derivative.mimeType,
      fileName: this.buildDerivativeFileName(attachment.originalFileName, variant),
      variantServed: variant,
      verifyFullSha256: false,
    };
  }

  async mintSingleGrant(
    reportId: string,
    attachmentId: string,
    dto: CreateDownloadGrantDto,
    viewer: FieldReportViewer,
  ): Promise<DownloadGrantResponseDto> {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    await this.accessService.assertCanRead(viewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const attachment = await this.prisma.fieldReportAttachment.findFirst({
      where: { id: attachmentId, reportId, deletedAt: null },
      include: { derivatives: true },
    });
    if (!attachment) {
      throw new NotFoundException({
        message: 'Attachment not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const policy = await this.policyService.resolveEffectivePolicy(viewer, report.entityId);
    const target = this.resolveAttachmentTarget(
      attachment,
      dto.variant,
      policy.canDownloadOriginal,
    );

    const ttlSeconds = this.configService.get<number>('fieldReports.downloadTokenTtlSeconds', 300);
    const defaultDisp: 'inline' | 'attachment' =
      dto.variant === 'THUMBNAIL' || dto.variant === 'PREVIEW' ? 'inline' : 'attachment';
    const disp = dto.disposition ?? defaultDisp;

    const payload: FieldReportDownloadGrantPayload = {
      jti: randomUUID(),
      purpose: 'field-report-download',
      scope: 'single',
      sub: viewer.userId,
      empId: viewer.employeeId,
      reportId,
      attachmentId,
      variant: dto.variant,
      disp,
    };

    const grantToken = await this.jwtService.signAsync(payload, {
      secret: resolveDownloadTokenSecret(this.configService),
      expiresIn: ttlSeconds,
    });

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return {
      grantToken,
      expiresAt,
      downloadUrl: `/api/v1/field-reports/downloads?grant=${encodeURIComponent(grantToken)}`,
      variantServed: target.variantServed,
      fileName: target.fileName,
      mimeType: target.mimeType,
      fileSizeBytes: target.plaintextSizeBytes,
    };
  }

  async mintZipGrant(
    reportId: string,
    dto: CreateZipDownloadGrantDto,
    viewer: FieldReportViewer,
  ): Promise<DownloadGrantResponseDto> {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    await this.accessService.assertCanRead(viewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const policy = await this.policyService.resolveEffectivePolicy(viewer, report.entityId);
    if (dto.variant === FieldReportDownloadVariant.ORIGINAL && !policy.canDownloadOriginal) {
      throw new ForbiddenException({
        message: 'Downloading Original ZIP archives is disabled by policy or role permissions.',
        error: 'ORIGINAL_DOWNLOAD_DISABLED_BY_POLICY',
      });
    }

    const revisionId = dto.revisionId ?? report.currentRevisionId;
    if (!revisionId) {
      throw new NotFoundException({
        message: 'No revision available to package.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const links = await this.prisma.fieldReportRevisionAttachment.findMany({
      where: {
        revisionId,
        attachment: {
          deletedAt: null,
          ...(dto.attachmentIds?.length ? { id: { in: dto.attachmentIds } } : {}),
        },
      },
      orderBy: { sortOrder: 'asc' },
      include: {
        attachment: {
          include: { derivatives: true },
        },
      },
    });

    if (links.length === 0) {
      throw new BadRequestException({
        message: 'This revision has no attachments to bundle.',
        error: 'INVALID_MEDIA_CONTENT',
      });
    }

    let totalBytes = 0;
    const attachmentIds: string[] = [];
    for (const l of links) {
      const requestedVariant: RequestedDownloadVariant =
        l.attachment.mediaKind === FieldMediaKind.DOCUMENT
          ? 'ORIGINAL'
          : dto.variant === FieldReportDownloadVariant.ORIGINAL
            ? 'ORIGINAL'
            : 'RESIZED';
      const resolved = this.resolveAttachmentTarget(
        l.attachment,
        requestedVariant,
        policy.canDownloadOriginal,
      );
      totalBytes += resolved.plaintextSizeBytes;
      attachmentIds.push(l.attachment.id);
    }

    const ttlSeconds = this.configService.get<number>('fieldReports.downloadTokenTtlSeconds', 300);
    const payload: FieldReportDownloadGrantPayload = {
      jti: randomUUID(),
      purpose: 'field-report-download',
      scope: 'zip',
      sub: viewer.userId,
      empId: viewer.employeeId,
      reportId,
      revisionId,
      attachmentIds,
      variant: dto.variant,
      disp: 'attachment',
    };

    const grantToken = await this.jwtService.signAsync(payload, {
      secret: resolveDownloadTokenSecret(this.configService),
      expiresIn: ttlSeconds,
    });

    const suffix = dto.variant === FieldReportDownloadVariant.ORIGINAL ? 'original' : 'resized';
    const zipName = `${sanitizeFileName(report.reportNumber)}_${suffix}.zip`;

    return {
      grantToken,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      downloadUrl: `/api/v1/field-reports/downloads/zip?grant=${encodeURIComponent(grantToken)}`,
      variantServed: dto.variant,
      fileName: zipName,
      mimeType: 'application/zip',
      fileSizeBytes: totalBytes,
    };
  }

  private async loadLiveViewer(userId: string): Promise<FieldReportViewer> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      select: {
        id: true,
        email: true,
        employee: { select: { id: true, deletedAt: true } },
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException({
        message: 'User account is inactive or no longer valid.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    const roles = user.roles.map((ur) => ur.role.name);
    const permSet = new Set<string>();
    for (const ur of user.roles) {
      for (const rp of ur.role.permissions) {
        permSet.add(`${rp.permission.subject}:${rp.permission.action}`);
      }
    }

    return {
      userId: user.id,
      email: user.email,
      employeeId: user.employee && !user.employee.deletedAt ? user.employee.id : undefined,
      roles,
      permissions: Array.from(permSet),
    };
  }

  private parseRangeHeader(
    rangeHeader: string | undefined,
    totalSize: number,
  ): { isPartial: boolean; startByte: number; endByte: number } {
    if (!rangeHeader || !rangeHeader.trim()) {
      return { isPartial: false, startByte: 0, endByte: totalSize - 1 };
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match) {
      throw new HttpException(
        { message: 'Unsupported or invalid Range header.', error: 'RANGE_NOT_SATISFIABLE' },
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      );
    }

    const [, rawStart, rawEnd] = match;
    let startByte: number;
    let endByte: number;

    if (rawStart === '' && rawEnd !== '') {
      // Suffix range bytes=-N
      const suffix = parseInt(rawEnd, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        throw new HttpException(
          { message: 'Invalid suffix byte range.', error: 'RANGE_NOT_SATISFIABLE' },
          HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        );
      }
      startByte = Math.max(0, totalSize - suffix);
      endByte = totalSize - 1;
    } else if (rawStart !== '') {
      startByte = parseInt(rawStart, 10);
      endByte = rawEnd !== '' ? parseInt(rawEnd, 10) : totalSize - 1;
      if (
        !Number.isFinite(startByte) ||
        !Number.isFinite(endByte) ||
        startByte < 0 ||
        endByte < startByte ||
        startByte >= totalSize
      ) {
        throw new HttpException(
          { message: 'Requested Range not satisfiable.', error: 'RANGE_NOT_SATISFIABLE' },
          HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        );
      }
      endByte = Math.min(endByte, totalSize - 1);
    } else {
      throw new HttpException(
        { message: 'Empty byte range.', error: 'RANGE_NOT_SATISFIABLE' },
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      );
    }

    return { isPartial: true, startByte, endByte };
  }

  private createSha256CheckTransform(expectedHex: string, attachmentId: string): Transform {
    const hash = createHash('sha256');
    const logger = this.logger;
    return new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        hash.update(chunk);
        cb(null, chunk);
      },
      flush(cb: TransformCallback) {
        const actual = hash.digest('hex');
        if (actual !== expectedHex) {
          logger.error(
            `[ALERT] Integrity failure on Original attachment ${attachmentId}: expected=${expectedHex} actual=${actual}`,
          );
          cb(new Error('Integrity checksum mismatch during Original download'));
          return;
        }
        cb();
      },
    });
  }

  private async recordPreviewView(userId: string, reportId: string, attachmentId: string) {
    try {
      const client = this.redisService.getClient();
      if (!client || !this.redisService.getIsConnected()) return;
      const dedupKey = `fr:pv_seen:${userId}:${attachmentId}`;
      const isNew = await client.set(dedupKey, '1', 'EX', 300, 'NX');
      if (isNew !== 'OK') return;
      const dayKey = new Date().toISOString().slice(0, 10);
      const aggKey = `fr:preview_agg:${dayKey}`;
      await client.hincrby(aggKey, `${userId}:${reportId}`, 1);
      await client.expire(aggKey, 14 * 24 * 60 * 60);
    } catch (e: any) {
      this.logger.warn(`Failed to increment preview audit aggregate: ${e?.message}`);
    }
  }

  async redeemSingleDownload(
    grant: FieldReportDownloadGrantPayload,
    rangeHeader: string | undefined,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (grant.scope !== 'single' || !grant.attachmentId) {
      throw new UnauthorizedException({
        message: 'Download grant is not scoped to a single attachment.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    const liveViewer = await this.loadLiveViewer(grant.sub);
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: grant.reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const { actedAsDelegateForId } = await this.accessService.assertCanRead(liveViewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const attachment = await this.prisma.fieldReportAttachment.findFirst({
      where: { id: grant.attachmentId, reportId: grant.reportId, deletedAt: null },
      include: { derivatives: true },
    });
    if (!attachment) {
      throw new NotFoundException({
        message: 'Attachment not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const policy = await this.policyService.resolveEffectivePolicy(liveViewer, report.entityId);
    const variant = grant.variant as RequestedDownloadVariant;
    const target = this.resolveAttachmentTarget(
      attachment,
      variant,
      policy.canDownloadOriginal,
    );

    if (
      (variant === 'ORIGINAL' || variant === 'RESIZED') &&
      attachment.mediaKind === FieldMediaKind.IMAGE &&
      variant === 'ORIGINAL' &&
      !policy.canDownloadOriginal
    ) {
      throw new ForbiddenException({
        message: 'Downloading Original images is disabled by policy.',
        error: 'ORIGINAL_DOWNLOAD_DISABLED_BY_POLICY',
      });
    }

    let range;
    try {
      range = this.parseRangeHeader(rangeHeader, target.plaintextSizeBytes);
    } catch (err) {
      res.setHeader('Content-Range', `bytes */${target.plaintextSizeBytes}`);
      throw err;
    }

    const plan = computeRangePlan(
      target.plaintextSizeBytes,
      range.startByte,
      range.endByte,
      target.chunkSizeBytes,
    );

    // Audit before opening response stream (fail-closed on formal downloads, aggregated on gallery previews).
    const ipAddress = req.ip || req.socket.remoteAddress;
    if (variant === 'ORIGINAL' || variant === 'RESIZED') {
      if (range.startByte === 0) {
        await this.auditService.log({
          actorId: liveViewer.userId,
          actorEmail: liveViewer.email,
          action: AuditAction.DOCUMENT_DOWNLOAD,
          entityType: 'FIELD_REPORT_ATTACHMENT',
          entityId: attachment.id,
          afterState: {
            reportId: report.id,
            reportNumber: report.reportNumber,
            variant: target.variantServed,
            fileSizeBytes: target.plaintextSizeBytes,
            keyId: target.keyId,
            checksumVerified: target.verifyFullSha256 && !range.isPartial,
            actedAsDelegateForId,
          },
          ipAddress,
        });
      }
    } else {
      await this.recordPreviewView(liveViewer.userId, report.id, attachment.id);
    }

    const encryptedStream = await this.storage.vault.getPartialStream(
      target.storageKey,
      plan.encryptedStartByte,
      plan.encryptedFetchLength,
    );

    const decryptTransform = this.storage.cipher.createDecryptTransform({
      storageKey: target.storageKey,
      objectUuid: target.objectUuid,
      iv: target.iv,
      keyId: target.keyId,
      plaintextSizeBytes: target.plaintextSizeBytes,
      chunkSizeBytes: target.chunkSizeBytes,
      startByte: range.startByte,
      endByte: range.endByte,
    });

    res.status(range.isPartial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', target.mimeType);
    res.setHeader('Content-Length', String(plan.rangeLengthBytes));
    res.setHeader(
      'Content-Disposition',
      this.buildContentDisposition(grant.disp || 'attachment', target.fileName),
    );
    if (range.isPartial) {
      res.setHeader(
        'Content-Range',
        `bytes ${range.startByte}-${range.endByte}/${target.plaintextSizeBytes}`,
      );
    }

    const shouldVerifyFullSha =
      target.verifyFullSha256 &&
      !range.isPartial &&
      range.startByte === 0 &&
      range.endByte === target.plaintextSizeBytes - 1;

    const transforms: any[] = [encryptedStream, decryptTransform];
    if (shouldVerifyFullSha) {
      transforms.push(this.createSha256CheckTransform(target.expectedSha256, attachment.id));
    }

    await new Promise<void>((resolve, reject) => {
      const onClose = () => {
        if (!res.writableEnded) {
          encryptedStream.destroy();
          resolve();
        }
      };
      req.once('close', onClose);

      (pipeline as any)(...transforms, res, (err?: NodeJS.ErrnoException | null) => {
        req.removeListener('close', onClose);
        if (err) {
          if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
            resolve();
            return;
          }
          this.logger.warn(`Download stream interrupted for ${attachment.id}: ${err.message}`);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async redeemZipDownload(
    grant: FieldReportDownloadGrantPayload,
    req: Request,
    res: Response,
  ): Promise<void> {
    if (grant.scope !== 'zip' || !Array.isArray(grant.attachmentIds) || grant.attachmentIds.length === 0) {
      throw new UnauthorizedException({
        message: 'Download grant is not scoped to a bulk ZIP archive.',
        error: 'DOWNLOAD_GRANT_INVALID',
      });
    }

    const liveViewer = await this.loadLiveViewer(grant.sub);
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: grant.reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const { actedAsDelegateForId } = await this.accessService.assertCanRead(liveViewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const policy = await this.policyService.resolveEffectivePolicy(liveViewer, report.entityId);
    const requestedVariant =
      grant.variant === FieldReportDownloadVariant.ORIGINAL
        ? FieldReportDownloadVariant.ORIGINAL
        : FieldReportDownloadVariant.RESIZED;

    if (requestedVariant === FieldReportDownloadVariant.ORIGINAL && !policy.canDownloadOriginal) {
      throw new ForbiddenException({
        message: 'Downloading Original ZIP archives is disabled by policy or role permissions.',
        error: 'ORIGINAL_DOWNLOAD_DISABLED_BY_POLICY',
      });
    }

    const attachments = await this.prisma.fieldReportAttachment.findMany({
      where: {
        id: { in: grant.attachmentIds },
        reportId: grant.reportId,
        deletedAt: null,
      },
      include: { derivatives: true },
    });
    const byId = new Map(attachments.map((a) => [a.id, a]));
    const ordered = grant.attachmentIds
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));

    if (ordered.length === 0) {
      throw new NotFoundException({
        message: 'No valid attachments remain for this archive.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    // Pre-validate every item BEFORE opening HTTP 200 ZIP headers!
    const targets: ResolvedDownloadTarget[] = ordered.map((att) => {
      const itemVariant: RequestedDownloadVariant =
        att.mediaKind === FieldMediaKind.DOCUMENT
          ? 'ORIGINAL'
          : requestedVariant === FieldReportDownloadVariant.ORIGINAL
            ? 'ORIGINAL'
            : 'RESIZED';
      return this.resolveAttachmentTarget(att, itemVariant, policy.canDownloadOriginal);
    });

    const totalPlainBytes = targets.reduce((sum, t) => sum + t.plaintextSizeBytes, 0);
    await this.auditService.log({
      actorId: liveViewer.userId,
      actorEmail: liveViewer.email,
      action: AuditAction.DOCUMENT_DOWNLOAD,
      entityType: 'FIELD_REPORT_ZIP',
      entityId: report.id,
      afterState: {
        reportNumber: report.reportNumber,
        revisionId: grant.revisionId ?? null,
        variant: requestedVariant,
        attachmentCount: targets.length,
        totalBytes: totalPlainBytes,
        actedAsDelegateForId,
      },
      ipAddress: req.ip || req.socket.remoteAddress,
    });

    const zipName = `${sanitizeFileName(report.reportNumber)}_${requestedVariant.toLowerCase()}.zip`;
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Content-Disposition', this.buildContentDisposition('attachment', zipName));

    const archive = archiver('zip', { store: true });
    let aborted = false;
    const onClose = () => {
      if (!res.writableEnded) {
        aborted = true;
        archive.abort();
      }
    };
    req.once('close', onClose);

    const archiveDone = new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
      archive.once('error', reject);
    });
    archiveDone.catch(() => {});

    archive.pipe(res);

    try {
      const seenNames = new Map<string, number>();
      for (let i = 0; i < targets.length; i++) {
        if (aborted) break;
        const target = targets[i];
        const prefix = String(i + 1).padStart(2, '0');
        let entryName = `${prefix}_${sanitizeFileName(target.fileName)}`;
        const count = seenNames.get(entryName) ?? 0;
        if (count > 0) {
          entryName = `${prefix}_${count}_${sanitizeFileName(target.fileName)}`;
        }
        seenNames.set(entryName, count + 1);

        const encryptedStream = await this.storage.vault.getStream(target.storageKey);
        const decryptTransform = this.storage.cipher.createDecryptTransform({
          storageKey: target.storageKey,
          objectUuid: target.objectUuid,
          iv: target.iv,
          keyId: target.keyId,
          plaintextSizeBytes: target.plaintextSizeBytes,
          chunkSizeBytes: target.chunkSizeBytes,
        });

        const entryPass = new PassThrough({ highWaterMark: 64 * 1024 });
        const pipeStages: any[] = [encryptedStream, decryptTransform];
        if (target.verifyFullSha256) {
          pipeStages.push(
            this.createSha256CheckTransform(target.expectedSha256, target.attachmentId),
          );
        }

        const entryStreaming = new Promise<void>((resolveEntry, rejectEntry) => {
          (pipeline as any)(...pipeStages, entryPass, (err?: Error | null) => {
            if (err) rejectEntry(err);
            else resolveEntry();
          });
        });

        archive.append(entryPass, { name: entryName });
        await entryStreaming;
      }

      if (!aborted) {
        await archive.finalize();
      }
      await archiveDone;
    } finally {
      req.removeListener('close', onClose);
    }
  }
}
