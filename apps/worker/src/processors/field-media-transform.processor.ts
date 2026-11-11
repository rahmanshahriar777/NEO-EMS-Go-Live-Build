import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Job, UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { prisma } from '@ems/database';
import {
  ChunkedCipherService,
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_FIELD_MEDIA_MAX_DIMENSION_PX,
  DEFAULT_FIELD_MEDIA_MAX_INPUT_PIXELS,
  MinioVaultClient,
  hasExifGpsIfd,
  loadEncryptionKeyRingFromEnv,
  loadMinioConfigFromEnv,
} from '@ems/storage';
import { FieldReportDerivativeKind } from '@ems/shared';
import { log } from '../logger.js';

export interface FieldMediaTransformDeps {
  db?: typeof prisma;
  vault?: MinioVaultClient;
  cipher?: ChunkedCipherService;
  sharpFactory?: typeof sharp;
  tmpDir?: string;
}

interface DerivativeSpec {
  kind: FieldReportDerivativeKind;
  maxEdge: number;
  format: 'webp' | 'jpeg';
  quality: number;
  mimeType: string;
  ext: string;
}

const DERIVATIVE_SPECS: DerivativeSpec[] = [
  {
    kind: FieldReportDerivativeKind.THUMBNAIL,
    maxEdge: 320,
    format: 'webp',
    quality: 75,
    mimeType: 'image/webp',
    ext: 'webp',
  },
  {
    kind: FieldReportDerivativeKind.WEB_PREVIEW,
    maxEdge: 1280,
    format: 'webp',
    quality: 82,
    mimeType: 'image/webp',
    ext: 'webp',
  },
  {
    kind: FieldReportDerivativeKind.RESIZED_STANDARD,
    maxEdge: 2048,
    format: 'jpeg',
    quality: 85,
    mimeType: 'image/jpeg',
    ext: 'jpg',
  },
];

let cachedVault: MinioVaultClient | null = null;
let cachedCipher: ChunkedCipherService | null = null;

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

function classifySharpError(err: any): {
  unrecoverable: boolean;
  code: 'DECOMPRESSION_BOMB_DETECTED' | 'UNSUPPORTED_CODEC' | 'INVALID_MEDIA_CONTENT' | 'PROCESSING_FAILED';
} {
  const msg = String(err?.message || err || '');
  if (/pixel limit|exceeds pixel|bomb safety|dimensions exceed/i.test(msg)) {
    return { unrecoverable: true, code: 'DECOMPRESSION_BOMB_DETECTED' };
  }
  if (/heif|hevc|compression format|unsupported codec|libde255/i.test(msg)) {
    return { unrecoverable: true, code: 'UNSUPPORTED_CODEC' };
  }
  if (/unsupported image format|corrupt|premature|bad seek|vips|invalid/i.test(msg)) {
    return { unrecoverable: true, code: 'INVALID_MEDIA_CONTENT' };
  }
  return { unrecoverable: false, code: 'PROCESSING_FAILED' };
}

export async function processGenerateDerivatives(
  job: Job<{ attachmentId: string; reportId: string; correlationId?: string }>,
  deps: FieldMediaTransformDeps = {},
) {
  const { attachmentId, reportId, correlationId } = job.data;
  const db = deps.db ?? prisma;
  const vault = deps.vault ?? getDefaultVault();
  const cipher = deps.cipher ?? getDefaultCipher();
  const sharpFn = deps.sharpFactory ?? sharp;
  const tmpRoot = deps.tmpDir ?? os.tmpdir();

  const attachment = await db.fieldReportAttachment.findFirst({
    where: { id: attachmentId, deletedAt: null },
    include: { derivatives: true },
  });

  if (!attachment) {
    log.warn('field-media.transform.missing', { attachmentId, reportId, correlationId });
    return { skipped: true, reason: 'attachment-not-found' };
  }

  // Strict scan-before-process gate — fail closed if unscanned or infected!
  if (attachment.scanStatus !== 'CLEAN') {
    throw new UnrecoverableError(
      `Refusing to transform attachment ${attachmentId} while scanStatus=${attachment.scanStatus}`,
    );
  }

  if (attachment.mediaKind !== 'IMAGE') {
    await db.fieldReportAttachment.update({
      where: { id: attachment.id },
      data: { processingStatus: 'SKIPPED', processingErrorCode: null },
    });
    return { skipped: true, reason: 'not-an-image' };
  }

  await db.fieldReportAttachment.update({
    where: { id: attachment.id },
    data: { processingStatus: 'PROCESSING', processingErrorCode: null },
  });

  const maxPixels = Number(
    process.env.FIELD_MEDIA_MAX_INPUT_PIXELS || DEFAULT_FIELD_MEDIA_MAX_INPUT_PIXELS,
  );
  const maxDim = Number(
    process.env.FIELD_MEDIA_MAX_DIMENSION_PX || DEFAULT_FIELD_MEDIA_MAX_DIMENSION_PX,
  );

  const tmpInput = path.join(tmpRoot, `fr-proc-${attachment.id}-${randomUUID()}`);

  try {
    // 1. Stream & decrypt Original directly to temp file so heap stays bounded.
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

    await pipeline(encryptedStream, decryptTransform, fs.createWriteStream(tmpInput));

    // 2. Inspect image metadata under sharp pixel limit & verify dimension bounds.
    const meta = await sharpFn(tmpInput, {
      limitInputPixels: maxPixels,
      sequentialRead: true,
      failOn: 'error',
    }).metadata();

    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    if (
      rawW <= 0 ||
      rawH <= 0 ||
      rawW * rawH > maxPixels ||
      Math.max(rawW, rawH) > maxDim
    ) {
      throw new Error(
        `Image dimensions ${rawW}x${rawH} exceed bomb safety limits (${maxPixels} px / ${maxDim} max edge)`,
      );
    }

    const embeddedGps = hasExifGpsIfd(meta.exif);
    const existingByKind = new Map(attachment.derivatives.map((d) => [d.kind, d]));

    // 3. Produce auto-rotated sRGB stripped derivatives, encrypt each, upload to MinIO, upsert DB.
    const createdKinds: string[] = [];
    for (const spec of DERIVATIVE_SPECS) {
      let pipelineInstance = sharpFn(tmpInput, {
        limitInputPixels: maxPixels,
        sequentialRead: true,
        failOn: 'error',
      })
        .rotate()
        .toColorspace('srgb')
        .resize(spec.maxEdge, spec.maxEdge, {
          fit: 'inside',
          withoutEnlargement: true,
        });

      // Note: without .keepMetadata()/.withMetadata(), sharp strips EXIF, GPS, XMP, and IPTC tags.
      if (spec.format === 'webp') {
        pipelineInstance = pipelineInstance.webp({ quality: spec.quality });
      } else {
        pipelineInstance = pipelineInstance.jpeg({ quality: spec.quality, mozjpeg: true });
      }

      const { data: outBuf, info } = await pipelineInstance.toBuffer({
        resolveWithObject: true,
      });

      const existing = existingByKind.get(spec.kind as any);
      const derivId = existing?.id ?? randomUUID();
      const derivKey = `field-reports/derivatives/${attachment.id}/${spec.kind.toLowerCase()}.${spec.ext}.enc`;

      const encrypted = cipher.encryptBuffer(outBuf, {
        storageKey: derivKey,
        objectUuid: derivId,
        chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
      });

      await vault.putBuffer(derivKey, encrypted.ciphertext, {
        'Content-Type': 'application/octet-stream',
      });

      await db.fieldReportDerivative.upsert({
        where: {
          attachmentId_kind: {
            attachmentId: attachment.id,
            kind: spec.kind as any,
          },
        },
        create: {
          id: derivId,
          attachmentId: attachment.id,
          kind: spec.kind as any,
          storageKey: derivKey,
          mimeType: spec.mimeType,
          fileSizeBytes: encrypted.plaintextSizeBytes,
          widthPx: info.width,
          heightPx: info.height,
          checksumSha256: encrypted.checksumSha256,
          iv: encrypted.iv,
          keyId: encrypted.keyId,
          chunkSizeBytes: encrypted.chunkSizeBytes,
          metadataStripped: true,
          colorspace: 'srgb',
        },
        update: {
          storageKey: derivKey,
          mimeType: spec.mimeType,
          fileSizeBytes: encrypted.plaintextSizeBytes,
          widthPx: info.width,
          heightPx: info.height,
          checksumSha256: encrypted.checksumSha256,
          iv: encrypted.iv,
          keyId: encrypted.keyId,
          chunkSizeBytes: encrypted.chunkSizeBytes,
          metadataStripped: true,
          colorspace: 'srgb',
        },
      });

      createdKinds.push(spec.kind);
    }

    await db.fieldReportAttachment.update({
      where: { id: attachment.id },
      data: {
        widthPx: rawW,
        heightPx: rawH,
        exifOrientation: meta.orientation ?? null,
        hasEmbeddedGps: embeddedGps,
        processingStatus: 'READY',
        processingErrorCode: null,
        processedAt: new Date(),
      },
    });

    log.info('field-media.transform.done', {
      jobId: job.id,
      attachmentId: attachment.id,
      reportId,
      rawW,
      rawH,
      orientation: meta.orientation ?? null,
      embeddedGps,
      derivatives: createdKinds,
      correlationId,
    });

    return {
      attachmentId: attachment.id,
      processingStatus: 'READY',
      derivatives: createdKinds,
      hasEmbeddedGps: embeddedGps,
    };
  } catch (err: any) {
    const classified = classifySharpError(err);
    await db.fieldReportAttachment
      .update({
        where: { id: attachment.id },
        data: {
          processingStatus: 'FAILED',
          processingErrorCode: classified.code,
        },
      })
      .catch(() => {});

    log.error('field-media.transform.failed', {
      jobId: job.id,
      attachmentId: attachment.id,
      reportId,
      code: classified.code,
      unrecoverable: classified.unrecoverable,
      error: err?.message,
      correlationId,
    });

    if (classified.unrecoverable) {
      throw new UnrecoverableError(err?.message || classified.code);
    }
    throw err;
  } finally {
    await fs.promises.rm(tmpInput, { force: true }).catch(() => {});
  }
}
