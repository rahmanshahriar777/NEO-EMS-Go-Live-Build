import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const DEFAULT_CHUNK_SIZE_BYTES = 262_144; // 256 KiB
export const GCM_TAG_BYTES = 16;
export const KEY_NONCE_BYTES = 12;
export const CHUNKED_ENCRYPTION_SCHEME = 'CHUNKED_GCM_V1';

const STAGING_KEY_WRAP_AAD = Buffer.from('ems-staging-key-wrap-v1', 'utf8');

export interface EncryptionKeyRing {
  primaryKey: Buffer;
  primaryKeyId: string;
  keysById: Map<string, Buffer>;
}

export interface RangePlan {
  plaintextSizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  totalEncryptedSize: number;
  startByte: number;
  endByte: number;
  rangeLengthBytes: number;
  firstChunk: number;
  lastChunk: number;
  encryptedStartByte: number;
  encryptedEndByte: number;
  encryptedFetchLength: number;
  headTrimBytes: number;
}

export interface ChunkedEncryptOptions {
  storageKey: string;
  objectUuid: string;
  plaintextSizeBytes: number;
  chunkSizeBytes?: number;
}

export interface ChunkedDecryptOptions {
  storageKey: string;
  objectUuid: string;
  iv: string;
  keyId: string;
  plaintextSizeBytes: number;
  chunkSizeBytes?: number;
  startByte?: number;
  endByte?: number;
}

export function deriveKeyId(key: Buffer): string {
  return `fp-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function parseHex32Key(hex: string, envName: string): Buffer {
  const clean = hex.trim();
  if (!/^[a-fA-F0-9]{64}$/.test(clean)) {
    throw new Error(`${envName} must be a 32-byte (64-char) hex-encoded key`);
  }
  return Buffer.from(clean, 'hex');
}

export function loadEncryptionKeyRingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EncryptionKeyRing {
  const primaryHex = env.DOCUMENT_ENCRYPTION_KEY;
  if (!primaryHex || !primaryHex.trim()) {
    throw new Error(
      'DOCUMENT_ENCRYPTION_KEY is not set: refusing to read or write encrypted vault objects',
    );
  }
  const primaryKey = parseHex32Key(primaryHex, 'DOCUMENT_ENCRYPTION_KEY');
  const computedPrimaryId = deriveKeyId(primaryKey);
  const configuredPrimaryId = env.DOCUMENT_ENCRYPTION_KEY_ID?.trim();
  const primaryKeyId = configuredPrimaryId || computedPrimaryId;

  const keysById = new Map<string, Buffer>();
  keysById.set(primaryKeyId, primaryKey);
  keysById.set(computedPrimaryId, primaryKey);

  const prevRaw = env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (prevRaw) {
    for (const part of prevRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const prevKey = parseHex32Key(part, 'DOCUMENT_ENCRYPTION_KEY_PREVIOUS');
      const prevId = deriveKeyId(prevKey);
      if (!keysById.has(prevId)) {
        keysById.set(prevId, prevKey);
      }
    }
  }

  return { primaryKey, primaryKeyId, keysById };
}

export function deriveObjectDek(
  masterKey: Buffer,
  baseNonce: Buffer,
  objectUuid: string,
): Buffer {
  const derived = hkdfSync(
    'sha256',
    masterKey,
    baseNonce,
    Buffer.from(`ems-field-v1:${objectUuid}`, 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

export function computeChunkNonce(baseNonce: Buffer, chunkIndex: number): Buffer {
  if (baseNonce.length !== KEY_NONCE_BYTES) {
    throw new Error(`Invalid baseNonce length: ${baseNonce.length}`);
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff_ffff) {
    throw new RangeError(`Chunk index out of uint32 range: ${chunkIndex}`);
  }
  const nonce = Buffer.from(baseNonce);
  const lowWord = nonce.readUInt32BE(8);
  nonce.writeUInt32BE((lowWord ^ (chunkIndex >>> 0)) >>> 0, 8);
  return nonce;
}

export function buildChunkAad(
  storageKey: string,
  chunkIndex: number,
  totalChunks: number,
  isFinal: boolean,
): Buffer {
  return Buffer.from(
    `${storageKey}:${chunkIndex}:${totalChunks}:${isFinal ? 1 : 0}`,
    'utf8',
  );
}

export function computeExpectedEncryptedSize(
  plaintextSizeBytes: number,
  chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES,
): number {
  if (!Number.isInteger(plaintextSizeBytes) || plaintextSizeBytes <= 0) {
    throw new RangeError(`plaintextSizeBytes must be a positive integer (got ${plaintextSizeBytes})`);
  }
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new RangeError(`chunkSizeBytes must be a positive integer`);
  }
  const totalChunks = Math.ceil(plaintextSizeBytes / chunkSizeBytes);
  return plaintextSizeBytes + totalChunks * GCM_TAG_BYTES;
}

export function computeRangePlan(
  plaintextSizeBytes: number,
  startByte: number,
  endByte: number,
  chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES,
): RangePlan {
  if (!Number.isInteger(plaintextSizeBytes) || plaintextSizeBytes <= 0) {
    throw new RangeError('plaintextSizeBytes must be > 0');
  }
  if (
    !Number.isInteger(startByte) ||
    !Number.isInteger(endByte) ||
    startByte < 0 ||
    endByte < startByte ||
    endByte >= plaintextSizeBytes
  ) {
    throw new RangeError(
      `Invalid byte range ${startByte}-${endByte} for file size ${plaintextSizeBytes}`,
    );
  }
  const totalChunks = Math.ceil(plaintextSizeBytes / chunkSizeBytes);
  const totalEncryptedSize = plaintextSizeBytes + totalChunks * GCM_TAG_BYTES;
  const stride = chunkSizeBytes + GCM_TAG_BYTES;

  const firstChunk = Math.floor(startByte / chunkSizeBytes);
  const lastChunk = Math.floor(endByte / chunkSizeBytes);

  const encryptedStartByte = firstChunk * stride;
  const encryptedEndByte =
    lastChunk === totalChunks - 1
      ? totalEncryptedSize - 1
      : (lastChunk + 1) * stride - 1;

  return {
    plaintextSizeBytes,
    chunkSizeBytes,
    totalChunks,
    totalEncryptedSize,
    startByte,
    endByte,
    rangeLengthBytes: endByte - startByte + 1,
    firstChunk,
    lastChunk,
    encryptedStartByte,
    encryptedEndByte,
    encryptedFetchLength: encryptedEndByte - encryptedStartByte + 1,
    headTrimBytes: startByte - firstChunk * chunkSizeBytes,
  };
}

function plaintextSizeOfChunk(
  chunkIndex: number,
  totalChunks: number,
  plaintextSizeBytes: number,
  chunkSizeBytes: number,
): number {
  if (chunkIndex < totalChunks - 1) {
    return chunkSizeBytes;
  }
  const rem = plaintextSizeBytes % chunkSizeBytes;
  return rem === 0 ? chunkSizeBytes : rem;
}

export class ChunkedCipherService {
  constructor(private readonly keyRing: EncryptionKeyRing) {}

  get primaryKeyId(): string {
    return this.keyRing.primaryKeyId;
  }

  resolveMasterKey(keyId: string): Buffer {
    const key = this.keyRing.keysById.get(keyId);
    if (!key) {
      throw new Error(`Unknown encryption keyId '${keyId}'`);
    }
    return key;
  }

  /**
   * Generate an ephemeral 256-bit staging key (hex) for upload session part encryption
   * and wrap it using the active vault master key.
   */
  createWrappedStagingKey(): { stagingKey: Buffer; wrapped: string } {
    const stagingKey = randomBytes(32);
    const iv = randomBytes(KEY_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyRing.primaryKey, iv);
    cipher.setAAD(STAGING_KEY_WRAP_AAD);
    const enc = Buffer.concat([cipher.update(stagingKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrapped = [
      'v1',
      this.keyRing.primaryKeyId,
      iv.toString('hex'),
      tag.toString('hex'),
      enc.toString('hex'),
    ].join(':');
    return { stagingKey, wrapped };
  }

  unwrapStagingKey(wrapped: string): Buffer {
    const parts = wrapped.split(':');
    if (parts.length !== 5 || parts[0] !== 'v1') {
      throw new Error('Malformed wrapped staging key');
    }
    const [, keyId, ivHex, tagHex, encHex] = parts;
    const masterKey = this.resolveMasterKey(keyId);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      masterKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAAD(STAGING_KEY_WRAP_AAD);
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  }

  encryptStagingPart(
    plaintext: Buffer,
    stagingKey: Buffer,
    sessionId: string,
    chunkIndex: number,
  ): Buffer {
    const iv = randomBytes(KEY_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', stagingKey, iv);
    cipher.setAAD(Buffer.from(`${sessionId}:${chunkIndex}`, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  decryptStagingPart(
    payload: Buffer,
    stagingKey: Buffer,
    sessionId: string,
    chunkIndex: number,
  ): Buffer {
    if (payload.length < KEY_NONCE_BYTES + GCM_TAG_BYTES + 1) {
      throw new Error('Staging part payload is truncated');
    }
    const iv = payload.subarray(0, KEY_NONCE_BYTES);
    const tag = payload.subarray(KEY_NONCE_BYTES, KEY_NONCE_BYTES + GCM_TAG_BYTES);
    const ct = payload.subarray(KEY_NONCE_BYTES + GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', stagingKey, iv);
    decipher.setAAD(Buffer.from(`${sessionId}:${chunkIndex}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  encryptBuffer(
    plaintext: Buffer,
    opts: Omit<ChunkedEncryptOptions, 'plaintextSizeBytes'>,
  ): {
    ciphertext: Buffer;
    iv: string;
    keyId: string;
    chunkSizeBytes: number;
    plaintextSizeBytes: number;
    checksumSha256: string;
  } {
    const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    const plaintextSizeBytes = plaintext.length;
    if (plaintextSizeBytes <= 0) {
      throw new RangeError('Cannot encrypt empty buffer under CHUNKED_GCM_V1');
    }
    const baseNonce = randomBytes(KEY_NONCE_BYTES);
    const keyId = this.keyRing.primaryKeyId;
    const dek = deriveObjectDek(this.keyRing.primaryKey, baseNonce, opts.objectUuid);
    const totalChunks = Math.ceil(plaintextSizeBytes / chunkSizeBytes);
    const parts: Buffer[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const slice = plaintext.subarray(i * chunkSizeBytes, (i + 1) * chunkSizeBytes);
      const isFinal = i === totalChunks - 1;
      const nonce = computeChunkNonce(baseNonce, i);
      const aad = buildChunkAad(opts.storageKey, i, totalChunks, isFinal);
      const cipher = createCipheriv('aes-256-gcm', dek, nonce);
      cipher.setAAD(aad);
      parts.push(cipher.update(slice));
      parts.push(cipher.final());
      parts.push(cipher.getAuthTag());
    }

    return {
      ciphertext: Buffer.concat(parts),
      iv: baseNonce.toString('hex'),
      keyId,
      chunkSizeBytes,
      plaintextSizeBytes,
      checksumSha256: createHash('sha256').update(plaintext).digest('hex'),
    };
  }

  decryptBuffer(ciphertext: Buffer, opts: ChunkedDecryptOptions): Buffer {
    const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    const startByte = opts.startByte ?? 0;
    const endByte = opts.endByte ?? opts.plaintextSizeBytes - 1;
    const plan = computeRangePlan(opts.plaintextSizeBytes, startByte, endByte, chunkSizeBytes);
    const expectedEncLen =
      opts.startByte !== undefined || opts.endByte !== undefined
        ? plan.encryptedFetchLength
        : plan.totalEncryptedSize;

    if (ciphertext.length !== expectedEncLen) {
      throw new Error(
        `Ciphertext length mismatch: expected ${expectedEncLen} bytes, got ${ciphertext.length}`,
      );
    }

    const masterKey = this.resolveMasterKey(opts.keyId);
    const baseNonce = Buffer.from(opts.iv, 'hex');
    const dek = deriveObjectDek(masterKey, baseNonce, opts.objectUuid);

    const out: Buffer[] = [];
    let offset = 0;

    for (let i = plan.firstChunk; i <= plan.lastChunk; i++) {
      const plainLen = plaintextSizeOfChunk(
        i,
        plan.totalChunks,
        opts.plaintextSizeBytes,
        chunkSizeBytes,
      );
      const ct = ciphertext.subarray(offset, offset + plainLen);
      const tag = ciphertext.subarray(offset + plainLen, offset + plainLen + GCM_TAG_BYTES);
      offset += plainLen + GCM_TAG_BYTES;

      const isFinal = i === plan.totalChunks - 1;
      const decipher = createDecipheriv('aes-256-gcm', dek, computeChunkNonce(baseNonce, i));
      decipher.setAAD(buildChunkAad(opts.storageKey, i, plan.totalChunks, isFinal));
      decipher.setAuthTag(tag);
      out.push(Buffer.concat([decipher.update(ct), decipher.final()]));
    }

    const combined = Buffer.concat(out);
    return combined.subarray(plan.headTrimBytes, plan.headTrimBytes + plan.rangeLengthBytes);
  }

  createEncryptTransform(opts: ChunkedEncryptOptions): {
    transform: Transform;
    iv: string;
    keyId: string;
    chunkSizeBytes: number;
  } {
    const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    const plaintextSizeBytes = opts.plaintextSizeBytes;
    if (!Number.isInteger(plaintextSizeBytes) || plaintextSizeBytes <= 0) {
      throw new RangeError('plaintextSizeBytes must be > 0');
    }
    const baseNonce = randomBytes(KEY_NONCE_BYTES);
    const keyId = this.keyRing.primaryKeyId;
    const dek = deriveObjectDek(this.keyRing.primaryKey, baseNonce, opts.objectUuid);
    const totalChunks = Math.ceil(plaintextSizeBytes / chunkSizeBytes);

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let chunkIndex = 0;
    let totalSeen = 0;

    const encryptChunk = (plainChunk: Buffer) => {
      const isFinal = chunkIndex === totalChunks - 1;
      const cipher = createCipheriv(
        'aes-256-gcm',
        dek,
        computeChunkNonce(baseNonce, chunkIndex),
      );
      cipher.setAAD(buildChunkAad(opts.storageKey, chunkIndex, totalChunks, isFinal));
      const c1 = cipher.update(plainChunk);
      const c2 = cipher.final();
      const tag = cipher.getAuthTag();
      chunkIndex += 1;
      return Buffer.concat([c1, c2, tag]);
    };

    const transform = new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        try {
          totalSeen += chunk.length;
          if (totalSeen > plaintextSizeBytes) {
            throw new Error(
              `Input stream exceeded declared plaintextSizeBytes (${plaintextSizeBytes})`,
            );
          }
          pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
          while (pending.length >= chunkSizeBytes) {
            const slice = pending.subarray(0, chunkSizeBytes);
            pending = pending.subarray(chunkSizeBytes);
            this.push(encryptChunk(slice));
          }
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      flush(cb: TransformCallback) {
        try {
          if (totalSeen !== plaintextSizeBytes) {
            throw new Error(
              `Input stream ended at ${totalSeen} bytes, expected ${plaintextSizeBytes}`,
            );
          }
          if (pending.length > 0) {
            this.push(encryptChunk(pending));
            pending = Buffer.alloc(0);
          }
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });

    return { transform, iv: baseNonce.toString('hex'), keyId, chunkSizeBytes };
  }

  createDecryptTransform(opts: ChunkedDecryptOptions): Transform {
    const chunkSizeBytes = opts.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    const startByte = opts.startByte ?? 0;
    const endByte = opts.endByte ?? opts.plaintextSizeBytes - 1;
    const plan = computeRangePlan(opts.plaintextSizeBytes, startByte, endByte, chunkSizeBytes);

    const masterKey = this.resolveMasterKey(opts.keyId);
    const baseNonce = Buffer.from(opts.iv, 'hex');
    const dek = deriveObjectDek(masterKey, baseNonce, opts.objectUuid);

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let currentChunk = plan.firstChunk;
    let emitted = 0;

    const processAvailable = (push: (buf: Buffer) => void) => {
      while (currentChunk <= plan.lastChunk) {
        const plainLen = plaintextSizeOfChunk(
          currentChunk,
          plan.totalChunks,
          opts.plaintextSizeBytes,
          chunkSizeBytes,
        );
        const encChunkLen = plainLen + GCM_TAG_BYTES;
        if (pending.length < encChunkLen) {
          break;
        }
        const encSlice = pending.subarray(0, encChunkLen);
        pending = pending.subarray(encChunkLen);

        const ct = encSlice.subarray(0, plainLen);
        const tag = encSlice.subarray(plainLen);
        const isFinal = currentChunk === plan.totalChunks - 1;

        const decipher = createDecipheriv(
          'aes-256-gcm',
          dek,
          computeChunkNonce(baseNonce, currentChunk),
        );
        decipher.setAAD(
          buildChunkAad(opts.storageKey, currentChunk, plan.totalChunks, isFinal),
        );
        decipher.setAuthTag(tag);
        let decrypted: Buffer<ArrayBufferLike> = Buffer.concat([decipher.update(ct), decipher.final()]);

        if (currentChunk === plan.firstChunk && plan.headTrimBytes > 0) {
          decrypted = decrypted.subarray(plan.headTrimBytes);
        }
        const remainingAllowed = plan.rangeLengthBytes - emitted;
        if (decrypted.length > remainingAllowed) {
          decrypted = decrypted.subarray(0, remainingAllowed);
        }
        if (decrypted.length > 0) {
          emitted += decrypted.length;
          push(decrypted);
        }
        currentChunk += 1;
      }
    };

    return new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
        try {
          pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
          processAvailable((buf) => this.push(buf));
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
      flush(cb: TransformCallback) {
        try {
          processAvailable((buf) => this.push(buf));
          if (currentChunk <= plan.lastChunk || pending.length !== 0) {
            throw new Error(
              `Encrypted object truncated or malformed (chunk ${currentChunk}/${plan.lastChunk}, trailing=${pending.length})`,
            );
          }
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });
  }
}
