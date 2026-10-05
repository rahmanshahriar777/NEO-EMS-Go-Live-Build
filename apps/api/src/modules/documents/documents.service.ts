import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { randomUUID, randomBytes, createCipheriv, CipherGCM } from 'crypto';
import { createReadStream } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { PassThrough } from 'stream';
import { PrismaService } from '../../core/prisma/prisma.service';
import { pickKnownColumns, hasColumn, tableExists } from '../../core/prisma/schema-compat.util';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { getCorrelationId } from '../../common/correlation/correlation';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemRole, AuditAction, JwtPayload, createPaginatedResponse } from '@ems/shared';
import {
  generateStorageKey,
  validateUpload,
  encryptBuffer,
  decryptBuffer,
  detectUploadMime,
  sha256Hex,
  readHeadBytes,
  hashFileSha256,
  MIME_SNIFF_HEAD_BYTES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_ALLOWED_MIME_TYPES,
} from './document-storage.util';
import {
  MalwareScanner,
  MalwareScanResult,
  NoopMalwareScanner,
  MALWARE_SCANNER,
} from './malware-scanner.interface';
import {
  extractDocumentFields,
  extractTextForIntelligence,
} from './document-intelligence.util';
import { DocumentQueryDto } from './dto/document.dto';

export interface DocumentViewer {
  userId: string;
  employeeId?: string;
  roles: string[];
}

interface UploadInput {
  title: string;
  category?: string;
  employeeId?: string;
  /** Document expiry (YYYY-MM-DD). Persisted when the column is migrated. */
  expiresAt?: string;
  file: Express.Multer.File;
}

/**
 * Encrypted document vault (SRS FR-DOC-001, closes F12).
 *
 * Security properties:
 * - Storage keys are server-generated uuid paths; the client never supplies a
 *   key (the old metadata endpoint that interpolated client `fileKey` into a
 *   hardcoded `http://` URL has been removed).
 * - Buffers are AES-256-GCM encrypted before upload when
 *   DOCUMENT_ENCRYPTION_ENABLED (default true). Fail-closed: the module
 *   refuses to boot without DOCUMENT_ENCRYPTION_KEY while enabled.
 * - Downloads are time-limited presigned GET URLs, never static links.
 * - Deletes are soft (deletedAt); bytes are retained for the retention window.
 * - List/get/delete are scoped: HR/SUPER_ADMIN see all; everyone else sees
 *   their own employee documents, documents they uploaded, and org-wide
 *   (employee-less) documents.
 */
@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly logger = new Logger(DocumentsService.name);
  private minio!: MinioClient;
  private readonly bucket: string;
  private readonly encryptionEnabled: boolean;
  private readonly encryptionKey: string;
  /**
   * Identifies the encryption key envelope used for new uploads; stamped on
   * every Document row as `keyId` (Phase 1 key-rotation tracking).
   *
   * From DOCUMENT_ENCRYPTION_KEY_ID when set (recommended: a rotation label
   * like `key-2026-01`), otherwise derived as a fingerprint of the key
   * itself (`fp-<sha256(key)[:12]>`) so forgetting to bump the label can
   * never silently mis-attribute rows after a key change. The fingerprint is
   * an identifier, not the key — it is safe to store per row.
   *
   * KEY ROTATION PROCEDURE (documented, not automated):
   *  1. Generate a new 32-byte DOCUMENT_ENCRYPTION_KEY.
   *  2. Set DOCUMENT_ENCRYPTION_KEY_ID to a new label (or rely on the
   *     fingerprint, which changes automatically with the key).
   *  3. Run a re-encryption job over rows with the old keyId (decrypt with
   *     the old key, encrypt with the new, update keyId) — never delete the
   *     old key from the vault until zero rows reference it.
   * New env var for worker 1's .env.example: DOCUMENT_ENCRYPTION_KEY_ID.
   */
  private readonly encryptionKeyId: string;
  private readonly maxFileSizeBytes: number;
  private readonly allowedMimeTypes: string[];
  private readonly presignedUrlExpirySeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly audit: AuditService,
    // Optional: notification centre hook (Phase 2 item 2). @Optional so this
    // service still constructs in unit tests that don't provide it.
    @Optional() private readonly notifications?: NotificationsService,
    // Central object-level policy (A1–A6). @Optional so unit tests that
    // construct the service directly keep working; the local ownership check
    // is the fallback when the policy service is absent.
    @Optional() private readonly accessPolicy?: AccessPolicyService,
    @Optional() @Inject(MALWARE_SCANNER) malwareScanner?: MalwareScanner,
  ) {
    this.bucket = this.configService.get<string>('S3_BUCKET') || 'ems-documents';
    this.encryptionEnabled =
      (this.configService.get<string>('DOCUMENT_ENCRYPTION_ENABLED') ?? 'true') === 'true';
    this.encryptionKey = this.configService.get<string>('DOCUMENT_ENCRYPTION_KEY') || '';
    this.encryptionKeyId =
      this.configService.get<string>('DOCUMENT_ENCRYPTION_KEY_ID') ||
      (this.encryptionKey
        ? `fp-${sha256Hex(Buffer.from(this.encryptionKey, 'utf8')).slice(0, 12)}`
        : 'unencrypted');
    this.maxFileSizeBytes =
      parseInt(this.configService.get<string>('DOCUMENT_MAX_FILE_SIZE_BYTES') || '', 10) ||
      DEFAULT_MAX_FILE_SIZE_BYTES;
    const allowlist = this.configService.get<string>('DOCUMENT_ALLOWED_MIME_TYPES');
    this.allowedMimeTypes = allowlist
      ? allowlist.split(',').map((m) => m.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_MIME_TYPES;
    this.presignedUrlExpirySeconds =
      parseInt(this.configService.get<string>('DOCUMENT_PRESIGNED_URL_EXPIRY_SECONDS') || '', 10) ||
      900; // 15 minutes

    // Fail-closed: never store documents unencrypted when encryption is on.
    if (this.encryptionEnabled && !this.encryptionKey) {
      throw new Error(
        'DOCUMENT_ENCRYPTION_KEY is required while DOCUMENT_ENCRYPTION_ENABLED=true. ' +
          'Set a 32-byte hex key or explicitly disable encryption (not recommended).',
      );
    }

    // Malware-scan hook (Phase 1 hardening). Default is the no-op scanner;
    // enabling the scan without a real scanner is a boot error, not a
    // silent skip.
    const scanEnabled =
      (this.configService.get<string>('DOCUMENT_MALWARE_SCAN_ENABLED') ?? 'false') === 'true';
    if (scanEnabled && (!malwareScanner || malwareScanner instanceof NoopMalwareScanner)) {
      throw new Error(
        'DOCUMENT_MALWARE_SCAN_ENABLED=true but no real MalwareScanner is registered ' +
          'for the MALWARE_SCANNER token. Register a ClamAV-backed scanner (see ' +
          'malware-scanner.interface.ts) or disable the scan explicitly.',
      );
    }
    this.malwareScanner = malwareScanner ?? new NoopMalwareScanner();
    this.malwareScanEnabled = scanEnabled;
  }

  private readonly malwareScanner: MalwareScanner;
  private readonly malwareScanEnabled: boolean;

  onModuleInit() {
    this.minio = new MinioClient({
      endPoint: this.configService.get<string>('S3_ENDPOINT') || 'localhost',
      port: parseInt(this.configService.get<string>('S3_PORT') || '9000', 10),
      useSSL: (this.configService.get<string>('S3_USE_SSL') ?? 'false') === 'true',
      accessKey: this.configService.get<string>('S3_ACCESS_KEY') || '',
      secretKey: this.configService.get<string>('S3_SECRET_KEY') || '',
      region: this.configService.get<string>('S3_REGION') || 'us-east-1',
    });
  }

  private isPrivileged(viewer: DocumentViewer): boolean {
    return (
      viewer.roles.includes(SystemRole.HR_ADMIN) || viewer.roles.includes(SystemRole.SUPER_ADMIN)
    );
  }

  /** Ownership/role scope for list/get (F12, A5). */
  private scopeWhere(viewer: DocumentViewer, filters: { employeeId?: string; category?: string }) {
    const where: any = {
      deletedAt: null,
      ...(filters.category && { category: filters.category }),
    };

    if (this.isPrivileged(viewer)) {
      if (filters.employeeId) where.employeeId = filters.employeeId;
      return where;
    }

    // A5: the employeeId filter is IGNORED for non-privileged viewers — they
    // always see exactly their own scope (self + own uploads + org-wide).
    // Without this, any employee could enumerate another employee's
    // documents by passing their id.
    const ownEmployeeId = viewer.employeeId;
    where.OR = [
      ...(ownEmployeeId ? [{ employeeId: ownEmployeeId }] : []),
      { uploadedById: viewer.userId },
      // Org-wide documents (no owning employee), e.g. company policies.
      { employeeId: null },
    ];
    return where;
  }

  /**
   * Object-level access for a single document: HR/admin pass; otherwise the
   * central AccessPolicyService decides for employee-owned documents
   * ("self, own team (direct reports), or HR"), while the uploader and
   * org-wide (employee-less) documents remain visible as before.
   */
  private async assertDocumentAccess(
    doc: { employeeId: string | null; uploadedById: string | null },
    viewer: DocumentViewer,
  ): Promise<void> {
    if (this.isPrivileged(viewer)) return;
    if (doc.uploadedById === viewer.userId) return;
    if (doc.employeeId === null) return;
    if (doc.employeeId && this.accessPolicy) {
      const ok = await this.accessPolicy.can(
        { userId: viewer.userId, roles: viewer.roles, employeeId: viewer.employeeId },
        doc.employeeId,
        'view',
      );
      if (ok) return;
    } else if (doc.employeeId && viewer.employeeId && doc.employeeId === viewer.employeeId) {
      // Fallback when the policy service is unavailable (unit tests).
      return;
    }
    throw new ForbiddenException('You do not have access to this document');
  }

  async findAll(viewer: DocumentViewer, query: DocumentQueryDto) {
    const { page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;
    const where = this.scopeWhere(viewer, {
      employeeId: query.employeeId,
      category: query.category,
    });

    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          fileName: true,
          mimeType: true,
          fileSize: true,
          category: true,
          employeeId: true,
          uploadedById: true,
          encrypted: true,
          // Exposed for key-rotation tracking (which key envelope per object).
          // Legacy fileKey/fileUrl are deliberately NOT selected here.
          keyId: true,
          checksum: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.document.count({ where }),
    ]);

    return createPaginatedResponse(items, total, page, limit);
  }

  async findOne(id: string, viewer: DocumentViewer) {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Document not found');

    await this.assertDocumentAccess(doc, viewer);

    // B5: presigned URLs are NEVER issued for still-encrypted objects — a
    // presigned GET would hand out ciphertext. Encrypted documents download
    // exclusively via GET /documents/:id/download (decrypt + stream + audit).
    const downloadUrl =
      !doc.encrypted && doc.storageKey
        ? await this.minio.presignedGetObject(
            this.bucket,
            doc.storageKey,
            this.presignedUrlExpirySeconds,
          )
        : null;

    const {
      fileKey: _legacy,
      fileUrl: _legacyUrl,
      storageKey: _storageKey,
      iv: _iv,
      ...rest
    } = doc as any;
    return {
      ...rest,
      // Never expose the raw storage key or interpolate it into URLs.
      downloadUrl,
      downloadUrlExpiresInSeconds: this.presignedUrlExpirySeconds,
      downloadPath: doc.encrypted ? `/documents/${doc.id}/download` : null,
    };
  }

  /**
   * B5: authenticated download. Ownership/role-checked via the access policy,
   * decrypted (AES-256-GCM) when the object is encrypted, streamed with the
   * stored content type, and audit-logged.
   *
   * Returns the plaintext bytes plus serving metadata; the controller turns
   * this into the HTTP stream.
   */
  async download(
    id: string,
    viewer: DocumentViewer,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string; fileSize: number }> {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Document not found');

    await this.assertDocumentAccess(doc, viewer);

    // fileKey is the legacy column; storageKey is the current one. Both are
    // read (never written by new code paths) until the drop migration.
    const objectKey = (doc as any).storageKey ?? (doc as any).fileKey;
    if (!objectKey) {
      throw new NotFoundException('Document has no stored object');
    }

    let bytes: Buffer;
    try {
      const stream = await this.minio.getObject(this.bucket, objectKey);
      bytes = await this.streamToBuffer(stream);
    } catch (error: any) {
      this.logger.error(`Failed to fetch object ${objectKey}: ${error.message}`);
      throw new NotFoundException('Document bytes unavailable');
    }

    let plaintext = bytes;
    if (doc.encrypted) {
      if (!doc.iv) {
        throw new BadRequestException('Encrypted document is missing its IV; cannot decrypt');
      }
      try {
        plaintext = decryptBuffer(bytes, this.encryptionKey, doc.iv);
      } catch (error: any) {
        this.logger.error(`Decryption failed for document ${id}: ${error.message}`);
        throw new BadRequestException('Document could not be decrypted (key mismatch?)');
      }
    }

    // Integrity check against the stored plaintext checksum when present.
    if (doc.checksum && sha256Hex(plaintext) !== doc.checksum) {
      this.logger.error(`Checksum mismatch for document ${id}: possible corruption or tampering`);
      throw new BadRequestException('Document failed its integrity check');
    }

    // The download itself is audited (who pulled which bytes, when).
    // NOTE: AuditAction has no READ/DOWNLOAD value yet — reported to worker 4
    // as an enum addition; UPDATE with a dedicated entityType is the honest
    // interim encoding.
    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.UPDATE,
      entityType: 'DOCUMENT_DOWNLOAD',
      entityId: id,
      afterState: {
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        bytesServed: plaintext.length,
        keyId: (doc as any).keyId ?? null,
      },
    });

    return {
      buffer: plaintext,
      mimeType: doc.mimeType,
      fileName: doc.fileName,
      fileSize: plaintext.length,
    };
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      (stream as any).on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      (stream as any).on('end', () => resolve(Buffer.concat(chunks)));
      (stream as any).on('error', reject);
    });
  }

  /**
   * Receives a multipart file, validates it, content-sniffs its MIME type,
   * malware-scans it, encrypts it, uploads it to MinIO/S3 under a
   * server-generated key, and records metadata.
   *
   * STREAMING (go-live hardening, §5): multer uses disk storage, so the file
   * arrives at `file.path` and is streamed to MinIO — the ≤25 MB file is
   * NEVER fully buffered in memory. AES-256-GCM is applied streaming (the
   * auth tag is appended at the end, same object layout as encryptBuffer(),
   * so downloads are unchanged) and the checksum is computed in a streaming
   * pass. The only remaining full read is the malware scan, and only when
   * scanning is enabled (bounded by DOCUMENT_MAX_FILE_SIZE_BYTES).
   * `file.buffer` inputs (tests, programmatic callers) keep the old
   * in-memory path.
   */
  async uploadDocument(input: UploadInput, uploader: DocumentViewer) {
    const { file } = input;
    // Disk-backed upload (multer diskStorage, production) vs in-memory
    // buffer (tests / programmatic callers).
    const diskPath =
      !file?.buffer && (file as Express.Multer.File & { path?: string })?.path
        ? ((file as Express.Multer.File & { path?: string }).path as string)
        : undefined;
    if (!file || (!file.buffer && !diskPath)) {
      throw new ForbiddenException('No file payload received');
    }
    const fileSize = file.buffer ? file.buffer.length : file.size;

    // Coarse gate on the client-claimed type/size first…
    validateUpload(file.mimetype, fileSize, this.allowedMimeTypes, this.maxFileSizeBytes);

    try {
      // …then the real gate: content-based MIME detection from the file head
      // (magic bytes live in the first bytes). The trusted type replaces the
      // client claim everywhere downstream.
      const head = file.buffer
        ? file.buffer.subarray(0, MIME_SNIFF_HEAD_BYTES)
        : await readHeadBytes(diskPath!, MIME_SNIFF_HEAD_BYTES);
      const { mimeType: trustedMime, detected } = await detectUploadMime(
        head,
        file.mimetype,
        this.allowedMimeTypes,
      );
      if (detected && trustedMime !== file.mimetype) {
        this.logger.warn(
          `MIME mismatch on upload "${file.originalname}": claimed ${file.mimetype}, detected ${trustedMime} — storing detected type`,
        );
      }

      // Malware-scan hook (Phase 1 hardening): no-op by default, ClamAV-backed
      // when DOCUMENT_MALWARE_SCAN_ENABLED=true (fail-closed at boot, and
      // fail-closed on scanner error — see assertCleanScan).
      if (this.malwareScanEnabled) {
        const scanBytes = file.buffer ?? (await readFile(diskPath!));
        await this.assertCleanScan(scanBytes, file.originalname, uploader.userId);
      }

      // Non-privileged uploaders can only attach documents to themselves.
      let employeeId = input.employeeId;
      if (!this.isPrivileged(uploader)) {
        employeeId = uploader.employeeId;
      }

      const storageKey = generateStorageKey(file.originalname);
      const checksum = file.buffer ? sha256Hex(file.buffer) : await hashFileSha256(diskPath!);

      // Upload: stream from disk (production) or from the buffer (tests).
      let iv: string | undefined;
      if (diskPath) {
        iv = await this.streamFileToMinio({
          filePath: diskPath,
          fileSize,
          storageKey,
          trustedMime,
          checksum,
        });
      } else {
        let payload = file.buffer!;
        if (this.encryptionEnabled) {
          const encrypted = encryptBuffer(file.buffer!, this.encryptionKey);
          payload = encrypted.data;
          iv = encrypted.iv;
        }
        await this.minio.putObject(this.bucket, storageKey, payload, payload.length, {
          'Content-Type': trustedMime,
          'X-Amz-Meta-Checksum-Sha256': checksum,
          'X-Amz-Meta-Encrypted': String(this.encryptionEnabled),
        });
      }

    // Document intelligence (Phase 3, item 8, stretch): heuristic expiry /
    // field extraction over text-extractable content. Suggestions only —
    // never persisted as facts without the caller's explicit expiresAt.
    // Only textual content is analysed; for disk uploads the file is read
    // here (bounded by DOCUMENT_MAX_FILE_SIZE_BYTES), binaries are skipped.
    let intelligence: { fields: any[]; suggestedExpiry?: string } = { fields: [] };
    const analysable =
      trustedMime.startsWith('text/') || trustedMime === 'application/json';
    const analysisBytes =
      file.buffer ?? (analysable && diskPath ? await readFile(diskPath) : null);
    const text = analysisBytes
      ? extractTextForIntelligence(analysisBytes, trustedMime)
      : null;
    if (text) {
      const result = extractDocumentFields(text);
      intelligence = { fields: result.fields, suggestedExpiry: result.suggestedExpiry };
    }
    const expiresAt = input.expiresAt ?? intelligence.suggestedExpiry ?? null;

    const doc = await this.prisma.document.create({
      data: {
        title: input.title,
        fileName: file.originalname,
        // Legacy fileKey column is NOT NULL: the mirror write stays until the
        // drop migration (worker 4). Reads are stripped from API responses.
        fileKey: storageKey,
        storageKey,
        mimeType: trustedMime,
        fileSize,
        category: (input.category || 'GENERAL').toUpperCase(),
        employeeId,
        uploadedById: uploader.userId,
        encrypted: this.encryptionEnabled,
        iv,
        checksum,
        // Key-rotation tracking: which key envelope encrypted this object.
        keyId: this.encryptionKeyId,
        // Expiry (Phase 2, item 7): column via worker 4 migration
        // (Document.expiresAt DateTime?); skipped while unmigrated.
        ...(await pickKnownColumns(
          this.prisma,
          'documents',
          expiresAt ? { expiresAt: new Date(expiresAt) } : {},
          'DocumentsService.uploadDocument',
        )),
      } as any,
    });

    await this.audit.log({
      actorId: uploader.userId,
      action: AuditAction.CREATE,
      entityType: 'DOCUMENT',
      entityId: doc.id,
      afterState: {
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        mimeType: trustedMime,
        detectedMime: detected,
        fileSize: doc.fileSize,
        checksum,
        encrypted: this.encryptionEnabled,
        keyId: this.encryptionKeyId,
        expiresAt,
      },
    });

    this.logger.log(`Document ${doc.id} uploaded to ${storageKey} by ${uploader.userId}`);

    // Notification centre hook (Phase 2 item 2): tell the document owner.
    // Fail-open — the upload already committed.
    await this.notifyDocumentUploaded(doc);

    return { ...doc, intelligence };
    } finally {
      // Multer's temp file must never linger, on success or failure.
      if (diskPath) {
        await unlink(diskPath).catch(() => {});
      }
    }
  }

  /**
   * Malware scan, FAIL-CLOSED (go-live hardening).
   *
   * When a real scanner IS configured (DOCUMENT_MALWARE_SCAN_ENABLED=true),
   * any scanner failure — a throw, a timeout, or an unclean verdict —
   * rejects the upload. A scanner error is never treated as "clean"; the
   * only way an upload proceeds is an explicit `{ clean: true }` verdict.
   * The scan itself is audited for the trail.
   */
  private async assertCleanScan(
    bytes: Buffer,
    fileName: string,
    actorId: string,
  ): Promise<void> {
    let scan: MalwareScanResult;
    try {
      scan = await this.malwareScanner.scan(bytes, fileName);
    } catch (e: any) {
      // Fail-closed: a scanner outage must not become an implicit pass.
      throw new BadRequestException(
        `Upload rejected: malware scan failed (${e?.message || 'scanner error'}) — try again later`,
      );
    }
    await this.audit.log({
      actorId,
      action: AuditAction.CREATE,
      entityType: 'DOCUMENT_MALWARE_SCAN',
      entityId: fileName,
      afterState: { scanner: scan.scanner, clean: scan.clean, threats: scan.threats },
    });
    if (!scan.clean) {
      throw new BadRequestException(
        `Upload rejected: malware scan detected ${scan.threats.join(', ') || 'a threat'}`,
      );
    }
  }

  /**
   * Streams a file from disk into MinIO without ever holding the whole file
   * in memory (go-live hardening, §5 performance).
   *
   * AES-256-GCM is applied streaming: chunks are encrypted as they flow and
   * the 16-byte auth tag is appended at the end — the stored object layout
   * (ciphertext || tag) is identical to encryptBuffer(), so the download
   * path (decryptBuffer) is unchanged. The total object size is known up
   * front (plaintext size + 16-byte tag when encrypted), so MinIO receives
   * an explicit size and never buffers for framing.
   *
   * @returns the hex IV when encryption is enabled (undefined otherwise).
   */
  private async streamFileToMinio(opts: {
    filePath: string;
    fileSize: number;
    storageKey: string;
    trustedMime: string;
    checksum: string;
  }): Promise<string | undefined> {
    const { filePath, fileSize, storageKey, trustedMime, checksum } = opts;

    let ivHex: string | undefined;
    let cipher: CipherGCM | null = null;
    if (this.encryptionEnabled) {
      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = randomBytes(12);
      ivHex = iv.toString('hex');
      cipher = createCipheriv('aes-256-gcm', key, iv);
    }

    const totalSize = fileSize + (cipher ? 16 : 0);
    const out = new PassThrough();
    const putPromise = this.minio.putObject(this.bucket, storageKey, out, totalSize, {
      'Content-Type': trustedMime,
      'X-Amz-Meta-Checksum-Sha256': checksum,
      'X-Amz-Meta-Encrypted': String(this.encryptionEnabled),
    });

    const src = createReadStream(filePath);
    const pump = new Promise<void>((resolve, reject) => {
      src.on('error', (e) => {
        out.destroy(e);
        reject(e);
      });
      out.on('error', reject);
      src.on('data', (chunk: Buffer) => {
        try {
          const data = cipher ? cipher.update(chunk) : chunk;
          // Backpressure: pause the file read while MinIO drains.
          if (data.length > 0 && !out.write(data)) src.pause();
        } catch (e) {
          src.destroy(e as Error);
          out.destroy(e as Error);
          reject(e);
        }
      });
      out.on('drain', () => src.resume());
      src.on('end', () => {
        try {
          if (cipher) {
            const final = cipher.final();
            if (final.length > 0) out.write(final);
            out.end(cipher.getAuthTag());
          } else {
            out.end();
          }
          resolve();
        } catch (e) {
          out.destroy(e as Error);
          reject(e);
        }
      });
    });

    try {
      await pump;
      await putPromise;
    } catch (e) {
      out.destroy(e as Error);
      // The put promise is already settling from the destroyed stream;
      // swallow its duplicate rejection so the original error propagates.
      await putPromise.catch(() => {});
      throw e;
    }
    return ivHex;
  }

  /** Soft-delete (F12): the row and its bytes are retained for the retention window. */
  async remove(id: string, viewer: DocumentViewer) {
    const doc = await this.prisma.document.findFirst({
      where: { id, deletedAt: null },
    });
    if (!doc) throw new NotFoundException('Document not found');

    const canDelete =
      this.isPrivileged(viewer) ||
      doc.uploadedById === viewer.userId ||
      (viewer.employeeId && doc.employeeId === viewer.employeeId);
    if (!canDelete) {
      throw new ForbiddenException('You do not have permission to delete this document');
    }

    await this.prisma.document.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.DELETE,
      entityType: 'DOCUMENT',
      entityId: id,
      beforeState: { id: doc.id, title: doc.title, storageKey: doc.storageKey },
    });

    return { message: 'Document soft-deleted', id };
  }

  /**
   * Correlation id for queue payloads that reference documents. Prefers the
   * ambient request correlation (inbound x-request-id via AsyncLocalStorage)
   * so worker logs join back to the originating request; mints a UUID only
   * outside a request context.
   */
  newCorrelationId(): string {
    return getCorrelationId() ?? randomUUID();
  }

  /**
   * Policy acknowledgement (Phase 2, item 7): the caller's employee record
   * acknowledges a document (typically a POLICY). Idempotent.
   *
   * Schema need (worker 4) — new model DocumentAcknowledgement:
   *   id String @id @default(uuid()); documentId String; employeeId String;
   *   acknowledgedAt DateTime @default(now());
   *   @@unique([documentId, employeeId]); @@map("document_acknowledgements")
   */
  async acknowledge(id: string, viewer: DocumentViewer) {
    if (!viewer.employeeId) {
      throw new ForbiddenException('An employee profile is required to acknowledge documents');
    }
    // Access-checked: you can only acknowledge documents you may see.
    await this.findOne(id, viewer);

    if (!(await tableExists(this.prisma, 'document_acknowledgements'))) {
      throw new ServiceUnavailableException(
        'Document acknowledgement requires the DocumentAcknowledgement migration (worker 4).',
      );
    }

    const ack = await (this.prisma as any).documentAcknowledgement.upsert({
      where: {
        documentId_employeeId: { documentId: id, employeeId: viewer.employeeId },
      },
      update: { acknowledgedAt: new Date() },
      create: { documentId: id, employeeId: viewer.employeeId },
    });

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.UPDATE,
      entityType: 'DOCUMENT_ACKNOWLEDGEMENT',
      entityId: id,
      afterState: { documentId: id, employeeId: viewer.employeeId, acknowledgedAt: ack.acknowledgedAt },
    });

    return { acknowledged: true, documentId: id, acknowledgedAt: ack.acknowledgedAt };
  }

  /** HR/admin: who acknowledged a document. */
  async getAcknowledgements(id: string) {
    if (!(await tableExists(this.prisma, 'document_acknowledgements'))) {
      return [];
    }
    return (this.prisma as any).documentAcknowledgement.findMany({
      where: { documentId: id },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
      orderBy: { acknowledgedAt: 'desc' },
    });
  }

  /**
   * Documents expiring within `withinDays` (Phase 2, item 7). HR/admin see
   * everything; others see their own + org-wide documents. Returns [] while
   * Document.expiresAt is unmigrated.
   */
  async listExpiring(viewer: DocumentViewer, withinDays = 30) {
    if (!(await hasColumn(this.prisma, 'documents', 'expiresAt'))) {
      this.logger.warn('listExpiring: Document.expiresAt not migrated yet — returning []');
      return [];
    }
    const now = new Date();
    const horizon = new Date(now.getTime() + withinDays * 86400_000);
    const scope = this.scopeWhere(viewer, {});
    const where: any = {
      ...scope,
      expiresAt: { gte: now, lte: horizon },
    };
    return (this.prisma as any).document.findMany({
      where,
      orderBy: { expiresAt: 'asc' },
      take: 100,
      select: {
        id: true,
        title: true,
        fileName: true,
        category: true,
        employeeId: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Expiry reminders (Phase 2, item 7): notifies each expiring document's
   * owner (and HR for org-wide documents). Intended for a worker cron —
   * reported as wiring follow-up for worker 1.
   */
  async sendExpiryReminders(withinDays = 30): Promise<{ reminded: number }> {
    const expiring = await this.listExpiring(
      { userId: 'system', roles: [SystemRole.HR_ADMIN] },
      withinDays,
    );
    if (!this.notifications) return { reminded: 0 };

    // All HR/admin users for org-wide documents.
    const hrUsers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: { some: { role: { name: { in: [SystemRole.HR_ADMIN, SystemRole.SUPER_ADMIN] } } } },
      },
      select: { id: true },
    });

    let reminded = 0;
    for (const doc of expiring) {
      const recipients = new Set<string>();
      if (doc.employeeId) {
        const emp = await this.prisma.employee.findUnique({
          where: { id: doc.employeeId },
          select: { userId: true },
        });
        if (emp?.userId) recipients.add(emp.userId);
      } else {
        for (const u of hrUsers) recipients.add(u.id);
      }
      const expiry = (doc as any).expiresAt?.toISOString?.().slice(0, 10) ?? 'soon';
      for (const userId of recipients) {
        try {
          await this.notifications.createNotification(
            userId,
            'Document expiring soon',
            `Document "${doc.title}" expires on ${expiry}.`,
            `/documents/${doc.id}`,
          );
          reminded++;
        } catch (e: any) {
          this.logger.warn(`Expiry reminder failed for ${doc.id}: ${e.message}`);
        }
      }
    }
    return { reminded };
  }

  /**
   * Notification centre hook (Phase 2 item 2): tells the document owner a new
   * document was filed against their profile (e.g. HR uploading a contract).
   * Fail-open — the upload already committed.
   */
  private async notifyDocumentUploaded(doc: any): Promise<void> {
    if (!this.notifications || !doc?.employeeId) return;
    try {
      const employee = await this.prisma.employee.findUnique({
        where: { id: doc.employeeId },
        select: { userId: true, email: true, firstName: true, lastName: true },
      });
      if (!employee?.userId) return;
      await this.notifications.notify({
        userId: employee.userId,
        template: 'document-uploaded',
        title: 'New document uploaded',
        message: `A new document "${doc.title}" (${doc.category}) was added to your profile.`,
        linkUrl: `/documents/${doc.id}`,
        idempotencyKey: `document-uploaded:${doc.id}`,
        emailCopy: true,
        emailTo: employee.email ?? undefined,
      });
    } catch (e: any) {
      this.logger.warn(`document-uploaded notification failed (fail-open): ${e.message}`);
    }
  }
}
