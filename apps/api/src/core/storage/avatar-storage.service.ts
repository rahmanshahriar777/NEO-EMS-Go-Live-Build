import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { PassThrough, Readable } from 'stream';

/**
 * MinIO-backed avatar storage (Phase 3 item 8, go-live hardening).
 *
 * Replaces base64 data-URL avatars stored in the DB (which bloat rows and
 * bypass the document vault's retention story). Semantics:
 * - `uploadAvatar()` stores the ORIGINAL file under
 *   `avatars/<employeeId>/<uuid>.<ext>` and returns the object key. The
 *   employee row keeps only the key (in `avatarUrl`, or a dedicated
 *   `avatarKey` column after worker 4's migration — see the wiring patch in
 *   the go-live report).
 * - `getAvatarUrl()` serves via time-limited presigned GET URLs (default 1
 *   hour), never static links.
 * - `deleteAvatar()` removes the object (best-effort; logs on failure).
 *
 * STREAMING (efficiency hardening): `uploadAvatar()` accepts either a
 * `Buffer` (tests, in-memory callers) or a `filePath` string (disk-backed
 * multer uploads). When a path is provided the file is streamed directly
 * to MinIO without loading the whole ≤5 MB into process heap.
 *
 * DEFERRED (documented, not implemented): resized variants. This service
 * deliberately takes NO image-processing dependency (no sharp): it stores
 * the original and serves it as-is. When variants are needed (thumbnails),
 * add an async variant-generation step (worker job or on-the-fly with
 * caching) — the key layout already namespaces per-employee objects so
 * `avatars/<employeeId>/<uuid>/thumb.webp` style variants slot in without
 * migrating existing keys.
 *
 * Safety: content-type allowlisted to images, size-capped
 * (AVATAR_MAX_BYTES, default 5 MB), keys are server-generated (no path
 * traversal — the employeeId segment is sanitised).
 */

const DEFAULT_MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface AvatarUploadResult {
  /** MinIO object key, e.g. `avatars/<employeeId>/<uuid>.jpg`. */
  key: string;
  mimeType: string;
  bytes: number;
}

/**
 * Input to `uploadAvatar`. Pass either `buffer` (in-memory, tests) or
 * `filePath` (disk-backed multer; preferred in production — streams without
 * buffering the whole file in heap).
 */
export interface AvatarUploadInput {
  employeeId: string;
  mimeType: string;
  /** In-memory bytes — used by tests and programmatic callers. */
  buffer?: Buffer;
  /**
   * Absolute path to a temp file on disk (multer diskStorage path).
   * When provided, the file is streamed to MinIO; `size` must also be set.
   */
  filePath?: string;
  /** File size in bytes — required when `filePath` is set. */
  size?: number;
}

@Injectable()
export class AvatarStorageService implements OnModuleInit {
  private readonly logger = new Logger(AvatarStorageService.name);
  private minio!: MinioClient;
  private readonly bucket: string;
  private readonly maxBytes: number;
  private readonly presignedExpirySeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('AVATAR_S3_BUCKET') || 'ems-avatars';
    this.maxBytes =
      parseInt(this.configService.get<string>('AVATAR_MAX_BYTES') || '', 10) ||
      DEFAULT_MAX_AVATAR_BYTES;
    this.presignedExpirySeconds =
      parseInt(this.configService.get<string>('AVATAR_PRESIGNED_URL_EXPIRY_SECONDS') || '', 10) ||
      3600; // 1 hour
  }

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

  /**
   * Store an avatar. Validates MIME type and size; the key is server-
   * generated (`avatars/<employeeId>/<uuid>.<ext>`).
   *
   * Production callers should pass `filePath` + `size` (multer diskStorage)
   * so the file is streamed to MinIO without being loaded into heap.
   * Test/programmatic callers may pass `buffer` instead.
   *
   * @deprecated signature `uploadAvatar(employeeId, buffer, mimeType)` is
   * kept for backward compatibility but is discouraged in production.
   */
  async uploadAvatar(
    employeeIdOrInput: string | AvatarUploadInput,
    legacyBuffer?: Buffer,
    legacyMimeType?: string,
  ): Promise<AvatarUploadResult> {
    // Normalise both call signatures.
    let employeeId: string;
    let buffer: Buffer | undefined;
    let filePath: string | undefined;
    let size: number | undefined;
    let mimeType: string;

    if (typeof employeeIdOrInput === 'string') {
      // Legacy signature: uploadAvatar(employeeId, buffer, mimeType)
      employeeId = employeeIdOrInput;
      buffer = legacyBuffer;
      mimeType = legacyMimeType!;
      size = buffer?.length;
    } else {
      ({ employeeId, buffer, filePath, size, mimeType } = employeeIdOrInput);
    }

    if (!ALLOWED_AVATAR_MIME_TYPES.has(mimeType)) {
      throw new BadRequestException(
        `Avatar type '${mimeType}' is not allowed. Allowed: ${[...ALLOWED_AVATAR_MIME_TYPES].join(', ')}`,
      );
    }

    // Resolve the byte count for validation.
    const byteCount = size ?? (buffer ? buffer.length : (filePath ? (await stat(filePath)).size : 0));

    if (byteCount === 0) {
      throw new BadRequestException('Avatar file is empty');
    }
    if (byteCount > this.maxBytes) {
      throw new BadRequestException(
        `Avatar size ${byteCount} bytes exceeds the maximum of ${this.maxBytes} bytes`,
      );
    }

    const safeEmployeeId = (employeeId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = MIME_TO_EXT[mimeType] ?? 'bin';
    const key = `avatars/${safeEmployeeId}/${randomUUID()}.${ext}`;

    if (filePath) {
      // STREAMING PATH (production): read from disk, pipe directly to MinIO.
      // The file is never fully buffered in process memory.
      const passThrough = new PassThrough();
      const src = createReadStream(filePath);

      const putPromise = this.minio.putObject(this.bucket, key, passThrough, byteCount, {
        'Content-Type': mimeType,
      });

      await new Promise<void>((resolve, reject) => {
        src.on('error', (e) => { passThrough.destroy(e); reject(e); });
        passThrough.on('error', reject);
        src.pipe(passThrough);
        src.on('end', resolve);
      });

      await putPromise;
    } else if (buffer) {
      // BUFFER PATH (tests / in-memory callers).
      const readable = Readable.from(buffer);
      await this.minio.putObject(this.bucket, key, readable, buffer.length, {
        'Content-Type': mimeType,
      });
    } else {
      throw new BadRequestException('Either buffer or filePath must be provided');
    }

    this.logger.log(`Avatar stored for employee ${safeEmployeeId} at ${key} (${byteCount} bytes)`);
    return { key, mimeType, bytes: byteCount };
  }

  /**
   * Time-limited presigned GET URL for an avatar key. Returns null when the
   * key is absent/blank (caller falls back to a default avatar).
   */
  async getAvatarUrl(key: string | null | undefined): Promise<string | null> {
    if (!key || !key.trim()) return null;
    // Never sign keys outside the avatars namespace.
    if (!key.startsWith('avatars/')) {
      throw new BadRequestException('Invalid avatar key');
    }
    return this.minio.presignedGetObject(this.bucket, key, this.presignedExpirySeconds);
  }

  /** Best-effort delete (old avatar after replacement). Logs on failure. */
  async deleteAvatar(key: string | null | undefined): Promise<void> {
    if (!key || !key.startsWith('avatars/')) return;
    try {
      await this.minio.removeObject(this.bucket, key);
    } catch (e: any) {
      this.logger.warn(`Failed to delete avatar object ${key}: ${e.message}`);
    }
  }
}
