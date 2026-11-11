import { Readable } from 'node:stream';
import {
  ChunkedCipherService,
  loadEncryptionKeyRingFromEnv,
} from '@ems/storage';

// Real valid 32x24 baseline JPEG encoded by sharp
const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCiAnyggAAAAAP/2Q==';

export const TEST_ENCRYPTION_KEY_1 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const TEST_ENCRYPTION_KEY_2 =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
export const TEST_DOWNLOAD_SECRET =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Builds a valid baseline JPEG containing a real APP1 EXIF segment with
 * IFD0 Orientation=6 and GPSInfoIFDPointer (0x8825) -> GPS sub-IFD.
 * Optional padding comments (COM 0xFFFE) allow exact target byte sizes for chunk tests.
 */
export function buildExifGpsJpeg(options?: {
  orientation?: number;
  includeGps?: boolean;
  padBytes?: number;
}): Buffer {
  const orientation = options?.orientation ?? 6;
  const includeGps = options?.includeGps ?? true;
  const base = Buffer.from(TINY_JPEG_BASE64, 'base64');

  // Build little-endian TIFF structure
  const entriesCount = includeGps ? 2 : 1;
  const tiffLen = includeGps ? 68 : 26;
  const tiff = Buffer.alloc(tiffLen, 0);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(entriesCount, 8);

  // Entry 0: Orientation (0x0112), SHORT (3), count=1
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);

  if (includeGps) {
    // Entry 1: GPSInfoIFDPointer (0x8825), LONG (4), count=1, value=38
    tiff.writeUInt16LE(0x8825, 22);
    tiff.writeUInt16LE(4, 24);
    tiff.writeUInt32LE(1, 26);
    tiff.writeUInt32LE(38, 30);
    // nextIFD = 0 at 34..37

    // GPS IFD at 38
    tiff.writeUInt16LE(2, 38);
    // GPSVersionID (0x0000), BYTE (1), count=4 -> 2.3.0.0
    tiff.writeUInt16LE(0x0000, 40);
    tiff.writeUInt16LE(1, 42);
    tiff.writeUInt32LE(4, 44);
    tiff.writeUInt8(2, 48);
    tiff.writeUInt8(3, 49);
    // GPSLatitudeRef (0x0001), ASCII (2), count=2 -> 'N\0'
    tiff.writeUInt16LE(0x0001, 52);
    tiff.writeUInt16LE(2, 54);
    tiff.writeUInt32LE(2, 56);
    tiff.write('N', 60, 'ascii');
  }

  const exifPrefix = Buffer.from('Exif\0\0', 'ascii');
  const app1Payload = Buffer.concat([exifPrefix, tiff]);
  const app1Segment = Buffer.alloc(4 + app1Payload.length);
  app1Segment.writeUInt16BE(0xffe1, 0);
  app1Segment.writeUInt16BE(2 + app1Payload.length, 2);
  app1Payload.copy(app1Segment, 4);

  const segments: Buffer[] = [base.subarray(0, 2), app1Segment];

  // Optional valid JPEG COM (0xFFFE) segments (each <= 64000 bytes) for multi-chunk upload tests
  let remainingPad = options?.padBytes ?? 0;
  while (remainingPad > 0) {
    const chunkPayload = Math.min(remainingPad, 60_000);
    const com = Buffer.alloc(4 + chunkPayload, 0x41);
    com.writeUInt16BE(0xfffe, 0);
    com.writeUInt16BE(2 + chunkPayload, 2);
    segments.push(com);
    remainingPad -= chunkPayload;
  }

  segments.push(base.subarray(2));
  return Buffer.concat(segments);
}

/**
 * In-memory MinIO vault double supporting putBuffer, putStream, getBuffer,
 * getStream, getPartialStream, removeObject, and removeObjects.
 */
export class InMemoryVaultDouble {
  readonly objects = new Map<string, Buffer>();

  async putBuffer(key: string, buf: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(buf));
  }

  async putStream(key: string, stream: Readable): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(parts));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`Object not found in vault: ${key}`);
    return Buffer.from(found);
  }

  async getStream(key: string): Promise<Readable> {
    const buf = await this.getBuffer(key);
    return Readable.from(chunkBuffer(buf, 32_768));
  }

  async getPartialStream(key: string, offset: number, length: number): Promise<Readable> {
    const buf = await this.getBuffer(key);
    const slice = buf.subarray(offset, offset + length);
    return Readable.from(chunkBuffer(slice, 32_768));
  }

  async removeObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async removeObjects(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
  }
}

function* chunkBuffer(buf: Buffer, step: number): Generator<Buffer> {
  for (let off = 0; off < buf.length; off += step) {
    yield buf.subarray(off, Math.min(buf.length, off + step));
  }
}

export function createTestCipher(keyHex: string = TEST_ENCRYPTION_KEY_1): ChunkedCipherService {
  const ring = loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: keyHex });
  return new ChunkedCipherService(ring);
}

