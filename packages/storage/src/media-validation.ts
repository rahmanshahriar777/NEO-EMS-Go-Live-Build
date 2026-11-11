import { Transform, type TransformCallback } from 'node:stream';

export const DEFAULT_FIELD_MEDIA_MAX_FILE_SIZE_BYTES = 52_428_800; // 50 MiB
export const DEFAULT_FIELD_REPORT_MAX_FILES = 20;
export const DEFAULT_FIELD_REPORT_MAX_TOTAL_BYTES = 262_144_000; // 250 MiB
export const DEFAULT_FIELD_MEDIA_CHUNK_SIZE_BYTES = 5_242_880; // 5 MiB
export const DEFAULT_FIELD_MEDIA_MAX_INPUT_PIXELS = 100_000_000; // 100 MP
export const DEFAULT_FIELD_MEDIA_MAX_DIMENSION_PX = 16_384;

export const FIELD_MEDIA_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const FIELD_MEDIA_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
] as const;

export const DEFAULT_FIELD_MEDIA_ALLOWED_MIME_TYPES: string[] = [
  ...FIELD_MEDIA_IMAGE_MIME_TYPES,
  ...FIELD_MEDIA_DOCUMENT_MIME_TYPES,
];

const TEXTUAL_MIME_TYPES = new Set(['text/plain', 'text/csv']);
const OOXML_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const ALLOWED_HEIF_STILL_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
  'heif',
]);

const FORBIDDEN_VIDEO_CONTAINER_BRANDS = new Set([
  'mp41',
  'mp42',
  'isom',
  'iso2',
  'qt  ',
  'avc1',
  'M4V ',
  'M4A ',
]);

export type MediaValidationErrorCode =
  | 'UNSUPPORTED_MIME_TYPE'
  | 'INVALID_MEDIA_CONTENT'
  | 'MACRO_ENABLED_OFFICE_FORBIDDEN';

export class MediaValidationError extends Error {
  constructor(
    public readonly code: MediaValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export function sanitizeFileName(raw: string): string {
  const leaf = (raw || 'file').split(/[\\/]/).pop() ?? 'file';
  const cleaned = leaf
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'file';
}

export function isImageMimeType(mime: string): boolean {
  return (FIELD_MEDIA_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Inspects ISO-BMFF `ftyp` header brands for HEIC/HEIF still images and rejects
 * disguised MP4/QuickTime video containers. Returns null if no `ftyp` header is present.
 */
export function inspectHeifFtypBrand(head: Buffer): {
  majorBrand: string;
  compatibleBrands: string[];
  isValidStillImage: boolean;
} | null {
  if (head.length < 16) return null;
  if (head.subarray(4, 8).toString('ascii') !== 'ftyp') return null;

  const boxSize = Math.min(head.readUInt32BE(0), head.length);
  const majorBrand = head.subarray(8, 12).toString('ascii');
  const compatibleBrands: string[] = [];
  for (let off = 16; off + 4 <= boxSize; off += 4) {
    compatibleBrands.push(head.subarray(off, off + 4).toString('ascii'));
  }

  const allBrands = [majorBrand, ...compatibleBrands];
  const hasStillBrand = allBrands.some((b) => ALLOWED_HEIF_STILL_BRANDS.has(b));
  const isVideoContainer =
    FORBIDDEN_VIDEO_CONTAINER_BRANDS.has(majorBrand) && !hasStillBrand;

  return {
    majorBrand,
    compatibleBrands,
    isValidStillImage: hasStillBrand && !isVideoContainer,
  };
}

/**
 * Strict UTF-8 text validation allowing international accented UTF-8 characters
 * while rejecting NUL bytes and binary control characters.
 */
export function validateUtf8TextBuffer(sample: Buffer): boolean {
  if (sample.length === 0 || sample.includes(0)) return false;

  // Trim up to 3 trailing continuation bytes if the sample sliced through a UTF-8 char.
  let end = sample.length;
  for (let back = 0; back < 3 && end > 0; back++) {
    const lastByte = sample[end - 1];
    if ((lastByte & 0xc0) === 0x80 || (lastByte & 0xe0) === 0xc0) {
      end -= 1;
      if ((lastByte & 0xc0) !== 0x80) break;
    } else {
      break;
    }
  }
  const sliced = end > 0 ? sample.subarray(0, end) : sample;

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(sliced);
  } catch {
    return false;
  }

  // Reject disallowed ASCII control characters (allow \t, \n, \r).
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Streaming Transform that detects `vbaProject.bin` (macro smuggling inside OOXML ZIPs)
 * without buffering the full file in RAM. Sets `detectedMacro = true` if found.
 */
export function createOoxmlMacroScannerTransform(): {
  transform: Transform;
  hasMacro: () => boolean;
} {
  const TARGET = Buffer.from('vbaproject.bin', 'ascii');
  let tail = Buffer.alloc(0);
  let found = false;

  const transform = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      if (!found) {
        const lower = Buffer.from(chunk.toString('latin1').toLowerCase(), 'latin1');
        const combined = tail.length > 0 ? Buffer.concat([tail, lower]) : lower;
        if (combined.includes(TARGET)) {
          found = true;
        }
        const keep = Math.min(TARGET.length - 1, combined.length);
        tail = Buffer.from(combined.subarray(combined.length - keep));
      }
      cb(null, chunk);
    },
  });

  return {
    transform,
    hasMacro: () => found,
  };
}

export interface DetectedFieldMedia {
  mimeType: string;
  mediaKind: 'IMAGE' | 'DOCUMENT';
  detectedByMagicBytes: boolean;
}

export async function detectFieldMediaMime(
  headBuffer: Buffer,
  claimedMime: string,
  allowedMimes: string[] = DEFAULT_FIELD_MEDIA_ALLOWED_MIME_TYPES,
  opts?: {
    hasVbaMacro?: boolean;
    fileTypeSniffer?: (buf: Buffer) => Promise<{ mime: string; ext?: string } | undefined>;
  },
): Promise<DetectedFieldMedia> {
  if (opts?.hasVbaMacro) {
    throw new MediaValidationError(
      'MACRO_ENABLED_OFFICE_FORBIDDEN',
      'Macro-enabled Office files (containing vbaProject.bin) are forbidden.',
    );
  }

  let sniffed: { mime: string; ext?: string } | undefined;
  if (opts?.fileTypeSniffer) {
    sniffed = await opts.fileTypeSniffer(headBuffer);
  } else {
    let fileTypeFromBufferFn:
      | ((buf: Buffer) => Promise<{ mime: string; ext?: string } | undefined>)
      | undefined;
    try {
      const mod = await import('file-type');
      fileTypeFromBufferFn = mod.fileTypeFromBuffer;
    } catch {
      // Jest's CJS VM disables native import() without --experimental-vm-modules;
      // fall back to require() so Jest module mocks cleanly satisfy file-type.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('file-type');
      fileTypeFromBufferFn = mod.fileTypeFromBuffer;
    }
    sniffed = await fileTypeFromBufferFn!(headBuffer);
  }

  if (sniffed) {
    let resolvedMime = sniffed.mime;

    // file-type identifies HEIC/HEIF as image/heic or image/heif; verify ftyp still-image brand.
    if (resolvedMime === 'image/heic' || resolvedMime === 'image/heif') {
      const ftyp = inspectHeifFtypBrand(headBuffer);
      if (!ftyp || !ftyp.isValidStillImage) {
        throw new MediaValidationError(
          'INVALID_MEDIA_CONTENT',
          'File claims HEIC/HEIF header but lacks a valid still-image ftyp brand',
        );
      }
    }

    // Reject generic application/zip when macro/non-OOXML containers attempt bypass.
    if (resolvedMime === 'application/zip' && OOXML_MIME_TYPES.has(claimedMime)) {
      resolvedMime = 'application/zip'; // explicitly stay disallowed
    }

    if (!allowedMimes.includes(resolvedMime)) {
      throw new MediaValidationError(
        'UNSUPPORTED_MIME_TYPE',
        `Detected file type '${resolvedMime}' is not allowed for field reporting.`,
      );
    }

    return {
      mimeType: resolvedMime,
      mediaKind: isImageMimeType(resolvedMime) ? 'IMAGE' : 'DOCUMENT',
      detectedByMagicBytes: true,
    };
  }

  // Fallback ONLY for text/plain & text/csv when claimed and valid UTF-8 text.
  if (TEXTUAL_MIME_TYPES.has(claimedMime) && allowedMimes.includes(claimedMime)) {
    if (!validateUtf8TextBuffer(headBuffer)) {
      throw new MediaValidationError(
        'INVALID_MEDIA_CONTENT',
        `File claimed as '${claimedMime}' does not decode as clean UTF-8 text.`,
      );
    }
    return {
      mimeType: claimedMime,
      mediaKind: 'DOCUMENT',
      detectedByMagicBytes: false,
    };
  }

  throw new MediaValidationError(
    'UNSUPPORTED_MIME_TYPE',
    `Could not verify allowed file type from content (claimed '${claimedMime || 'unknown'}').`,
  );
}

/**
 * Parses a raw TIFF/EXIF buffer (such as `sharp().metadata().exif`) to check whether
 * IFD0 contains GPSInfoIFDPointer tag `0x8825`. Returns false safely on malformed data.
 */
export function hasExifGpsIfd(exifBuffer: Buffer | null | undefined): boolean {
  if (!exifBuffer || exifBuffer.length < 14) return false;

  // Strip optional "Exif\0\0" APP1 prefix if present
  let tiff = exifBuffer;
  if (
    tiff.length >= 6 &&
    tiff[0] === 0x45 &&
    tiff[1] === 0x78 &&
    tiff[2] === 0x69 &&
    tiff[3] === 0x66 &&
    tiff[4] === 0x00 &&
    tiff[5] === 0x00
  ) {
    tiff = tiff.subarray(6);
  }
  if (tiff.length < 8) return false;

  const endian = tiff.subarray(0, 2).toString('ascii');
  let le: boolean;
  if (endian === 'II') {
    le = true;
  } else if (endian === 'MM') {
    le = false;
  } else {
    return false;
  }

  const readU16 = (off: number) =>
    le ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off);
  const readU32 = (off: number) =>
    le ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off);

  if (readU16(2) !== 42) return false;
  const ifd0Offset = readU32(4);
  if (ifd0Offset + 2 > tiff.length) return false;

  const entryCount = readU16(ifd0Offset);
  for (let i = 0; i < entryCount; i++) {
    const entryOff = ifd0Offset + 2 + i * 12;
    if (entryOff + 12 > tiff.length) break;
    const tagId = readU16(entryOff);
    if (tagId === 0x8825) {
      return true;
    }
  }
  return false;
}
