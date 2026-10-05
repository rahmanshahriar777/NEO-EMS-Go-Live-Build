import { BadRequestException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'crypto';
import { createReadStream } from 'fs';
import { open } from 'fs/promises';

/**
 * Document vault helpers (SRS FR-DOC-001).
 *
 * - Storage keys are ALWAYS server-generated (`documents/<uuid>/<safe-name>`);
 *   the client never supplies a key, which closes the path-traversal vector in
 *   the old metadata endpoint (F12).
 * - File buffers are encrypted with AES-256-GCM before upload. The 32-byte key
 *   comes from the `DOCUMENT_ENCRYPTION_KEY` env var (hex-encoded). Encryption
 *   is enabled by default and the service fails closed at boot when the key is
 *   absent.
 */

// Default cap: 10 MB. Overridable via DOCUMENT_MAX_FILE_SIZE_BYTES.
export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Default mime allowlist. Overridable via DOCUMENT_ALLOWED_MIME_TYPES
// (comma-separated). Block executables/scripts by never allowlisting them.
export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export interface EncryptedPayload {
  /** AES-256-GCM ciphertext (auth tag appended). */
  data: Buffer;
  /** 12-byte IV, hex-encoded. */
  iv: string;
}

/**
 * Generates a server-side storage key. The uuid segment makes keys
 * unguessable; the sanitized filename keeps them human-readable without ever
 * trusting client path segments (`..`, `/` are stripped).
 */
export function generateStorageKey(originalName: string): string {
  const safe = (originalName || 'file')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  return `documents/${randomUUID()}/${safe || 'file'}`;
}

export function validateUpload(
  mimeType: string,
  size: number,
  allowedMimes: string[],
  maxBytes: number,
): void {
  if (!mimeType || !allowedMimes.includes(mimeType)) {
    throw new BadRequestException(
      `File type '${mimeType || 'unknown'}' is not allowed. Allowed types: ${allowedMimes.join(', ')}`,
    );
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestException('Uploaded file is empty');
  }
  if (size > maxBytes) {
    throw new BadRequestException(
      `File size ${size} bytes exceeds the maximum of ${maxBytes} bytes`,
    );
  }
}

/**
 * Encrypts a buffer with AES-256-GCM. Key must be 32 bytes (hex-encoded).
 * Throws if the key is missing/invalid — fail-closed, never uploads plaintext
 * when encryption is enabled.
 */
export function encryptBuffer(buffer: Buffer, keyHex: string): EncryptedPayload {
  if (!keyHex) {
    throw new Error(
      'DOCUMENT_ENCRYPTION_KEY is not set: refusing to store documents unencrypted',
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      'DOCUMENT_ENCRYPTION_KEY must be a 32-byte hex-encoded key for AES-256-GCM',
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    data: Buffer.concat([ciphertext, authTag]),
    iv: iv.toString('hex'),
  };
}

export function decryptBuffer(
  payload: Buffer,
  keyHex: string,
  ivHex: string,
): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Bytes read from the file head for content sniffing. Magic-byte signatures
 * live in the first bytes (file-type only reads the head), and the textual
 * fallback samples the first 8000 bytes — identical to the old full-buffer
 * behaviour without buffering the whole file.
 */
export const MIME_SNIFF_HEAD_BYTES = 8192;

/** Read up to `n` bytes from the start of a file (streaming upload path). */
export async function readHeadBytes(
  filePath: string,
  n: number = MIME_SNIFF_HEAD_BYTES,
): Promise<Buffer> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Streaming SHA-256 of a file — no full memory buffering. */
export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const src = createReadStream(filePath);
    src.on('error', reject);
    src.on('data', (chunk: Buffer) => hash.update(chunk));
    src.on('end', () => {
      try {
        resolve(hash.digest('hex'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Content-based MIME detection (Phase 1 hardening — uploads).
//
// The multipart `mimetype` is client-supplied and therefore untrusted. Every
// upload is sniffed with the `file-type` package (magic bytes); the detected
// type must be allowlisted. Buffers with no detectable signature are only
// accepted when the claimed type is textual (text/plain, text/csv) AND the
// bytes decode as text — this keeps CSV/TXT uploads working without opening
// a polyglot hole for binaries masquerading as text.
//
// file-type v22 is ESM-only: dynamic import, never require().
// ---------------------------------------------------------------------------

/** MIME types that are legitimately undetectable (no magic bytes). */
const TEXTUAL_MIME_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);

function bufferLooksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 8000).toString('utf8');
  if (sample.length === 0) return false;
  const printable = (sample.match(/[\x20-\x7E\t\n\r]/g) || []).length;
  return printable / sample.length >= 0.95;
}

export interface MimeDetection {
  /** The trusted MIME type to store/serve. */
  mimeType: string;
  /** True when identified by magic bytes (vs. textual fallback). */
  detected: boolean;
}

/**
 * Returns the trusted MIME type for an upload buffer, or throws when the
 * content does not match the allowlist. `claimedMime` is the client-supplied
 * multipart type (used only for the textual fallback path).
 */
export async function detectUploadMime(
  buffer: Buffer,
  claimedMime: string,
  allowedMimes: string[],
): Promise<MimeDetection> {
  // ESM-only package: dynamic import (worker 6 infra note).
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(buffer);

  if (detected) {
    if (!allowedMimes.includes(detected.mime)) {
      throw new BadRequestException(
        `Detected file type '${detected.mime}' is not allowed. Allowed types: ${allowedMimes.join(', ')}`,
      );
    }
    // Trust the sniffed type over the client claim — never store a spoofed
    // extension/type (e.g. an executable renamed to .pdf).
    return { mimeType: detected.mime, detected: true };
  }

  // No magic-byte signature: accept only textual content with a textual claim.
  if (TEXTUAL_MIME_TYPES.has(claimedMime) && allowedMimes.includes(claimedMime)) {
    if (!bufferLooksLikeText(buffer)) {
      throw new BadRequestException(
        `File claimed as '${claimedMime}' does not decode as text; upload rejected`,
      );
    }
    return { mimeType: claimedMime, detected: false };
  }

  throw new BadRequestException(
    `Could not identify the file type from its content (claimed '${claimedMime || 'unknown'}'); ` +
      'upload rejected',
  );
}
