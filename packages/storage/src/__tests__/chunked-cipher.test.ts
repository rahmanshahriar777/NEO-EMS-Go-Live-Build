import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ChunkedCipherService,
  DEFAULT_CHUNK_SIZE_BYTES,
  GCM_TAG_BYTES,
  computeRangePlan,
  deriveKeyId,
  loadEncryptionKeyRingFromEnv,
} from '../chunked-cipher.js';

const KEY_1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

describe('ChunkedCipherService (CHUNKED_GCM_V1)', () => {
  it('encrypts and decrypts multi-chunk buffer cleanly and verifies SHA-256', () => {
    const ring = loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: KEY_1 });
    const cipher = new ChunkedCipherService(ring);
    // 2.5 chunks (~640 KiB)
    const plaintext = randomBytes(DEFAULT_CHUNK_SIZE_BYTES * 2 + 123_456);
    const storageKey = 'field-reports/originals/rep-1/att-1.enc';
    const objectUuid = 'att-1';

    const enc = cipher.encryptBuffer(plaintext, { storageKey, objectUuid });
    assert.equal(enc.keyId, deriveKeyId(Buffer.from(KEY_1, 'hex')));
    assert.equal(enc.plaintextSizeBytes, plaintext.length);
    assert.equal(enc.ciphertext.length, plaintext.length + 3 * GCM_TAG_BYTES);

    const dec = cipher.decryptBuffer(enc.ciphertext, {
      storageKey,
      objectUuid,
      iv: enc.iv,
      keyId: enc.keyId,
      plaintextSizeBytes: enc.plaintextSizeBytes,
    });
    assert.equal(Buffer.compare(dec, plaintext), 0);
  });

  it('supports arbitrary byte-offset HTTP Range reads spanning chunk boundaries', async () => {
    const ring = loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: KEY_1 });
    const cipher = new ChunkedCipherService(ring);
    const plaintext = randomBytes(DEFAULT_CHUNK_SIZE_BYTES * 2 + 5_000);
    const storageKey = 'field-reports/originals/rep-2/att-2.enc';
    const objectUuid = 'att-2';
    const enc = cipher.encryptBuffer(plaintext, { storageKey, objectUuid });

    const cases: Array<[number, number]> = [
      [0, 100],
      [262_140, 262_300], // crosses chunk 0 -> chunk 1 boundary
      [DEFAULT_CHUNK_SIZE_BYTES * 2, plaintext.length - 1], // final chunk tail
      [17, plaintext.length - 23], // wide range spanning 3 chunks
    ];

    for (const [startByte, endByte] of cases) {
      const plan = computeRangePlan(plaintext.length, startByte, endByte);
      const encSlice = enc.ciphertext.subarray(plan.encryptedStartByte, plan.encryptedEndByte + 1);
      const chunks: Buffer[] = [];
      const decryptTx = cipher.createDecryptTransform({
        storageKey,
        objectUuid,
        iv: enc.iv,
        keyId: enc.keyId,
        plaintextSizeBytes: plaintext.length,
        startByte,
        endByte,
      });

      await pipeline(Readable.from([encSlice.subarray(0, 777), encSlice.subarray(777)]), decryptTx, async (src) => {
        for await (const c of src) {
          chunks.push(c as Buffer);
        }
      });

      const sliced = Buffer.concat(chunks);
      assert.equal(Buffer.compare(sliced, plaintext.subarray(startByte, endByte + 1)), 0);
    }
  });

  it('detects 1-bit ciphertext tamper, chunk swapping, and trailing truncation via AAD', () => {
    const ring = loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: KEY_1 });
    const cipher = new ChunkedCipherService(ring);
    const plaintext = randomBytes(DEFAULT_CHUNK_SIZE_BYTES * 2 + 1024);
    const storageKey = 'field-reports/originals/rep-3/att-3.enc';
    const objectUuid = 'att-3';
    const enc = cipher.encryptBuffer(plaintext, { storageKey, objectUuid });

    // 1. 1-bit tamper in ciphertext
    const tampered = Buffer.from(enc.ciphertext);
    tampered[100] ^= 0x01;
    assert.throws(() =>
      cipher.decryptBuffer(tampered, {
        storageKey,
        objectUuid,
        iv: enc.iv,
        keyId: enc.keyId,
        plaintextSizeBytes: plaintext.length,
      }),
    );

    // 2. Chunk swap: swap chunk 0 and chunk 1
    const stride = DEFAULT_CHUNK_SIZE_BYTES + GCM_TAG_BYTES;
    const swapped = Buffer.concat([
      enc.ciphertext.subarray(stride, stride * 2),
      enc.ciphertext.subarray(0, stride),
      enc.ciphertext.subarray(stride * 2),
    ]);
    assert.throws(() =>
      cipher.decryptBuffer(swapped, {
        storageKey,
        objectUuid,
        iv: enc.iv,
        keyId: enc.keyId,
        plaintextSizeBytes: plaintext.length,
      }),
    );

    // 3. Cross-object storageKey substitution
    assert.throws(() =>
      cipher.decryptBuffer(enc.ciphertext, {
        storageKey: 'field-reports/originals/rep-OTHER/att-3.enc',
        objectUuid,
        iv: enc.iv,
        keyId: enc.keyId,
        plaintextSizeBytes: plaintext.length,
      }),
    );

    // 4. Truncation claim (passing wrong plaintextSizeBytes=chunk0.length against chunk 0 AAD expecting totalChunks=3)
    const chunk0Enc = enc.ciphertext.subarray(0, stride);
    assert.throws(() =>
      cipher.decryptBuffer(chunk0Enc, {
        storageKey,
        objectUuid,
        iv: enc.iv,
        keyId: enc.keyId,
        plaintextSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
      }),
    );
  });

  it('supports seamless decrypt after key rotation via DOCUMENT_ENCRYPTION_KEY_PREVIOUS', () => {
    const oldRing = loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: KEY_1 });
    const oldCipher = new ChunkedCipherService(oldRing);
    const plaintext = randomBytes(70_000);
    const enc = oldCipher.encryptBuffer(plaintext, {
      storageKey: 'field-reports/originals/r/a.enc',
      objectUuid: 'a',
    });

    // Rotate primary to KEY_2 while retaining KEY_1 in PREVIOUS
    const newRing = loadEncryptionKeyRingFromEnv({
      DOCUMENT_ENCRYPTION_KEY: KEY_2,
      DOCUMENT_ENCRYPTION_KEY_PREVIOUS: KEY_1,
    });
    const newCipher = new ChunkedCipherService(newRing);
    assert.notEqual(newCipher.primaryKeyId, enc.keyId);

    const dec = newCipher.decryptBuffer(enc.ciphertext, {
      storageKey: 'field-reports/originals/r/a.enc',
      objectUuid: 'a',
      iv: enc.iv,
      keyId: enc.keyId,
      plaintextSizeBytes: plaintext.length,
    });
    assert.equal(Buffer.compare(dec, plaintext), 0);
  });

  it('streams encrypt & decrypt and wraps/unwraps ephemeral staging keys', async () => {
    const ring = loadEncryptionKeyRingFromEnv({
      DOCUMENT_ENCRYPTION_KEY: KEY_2,
      DOCUMENT_ENCRYPTION_KEY_PREVIOUS: KEY_1,
    });
    const cipher = new ChunkedCipherService(ring);
    const { stagingKey, wrapped } = cipher.createWrappedStagingKey();
    const unwrapped = cipher.unwrapStagingKey(wrapped);
    assert.equal(Buffer.compare(stagingKey, unwrapped), 0);

    const slice = Buffer.from('hello-chunk-0-payload');
    const encPart = cipher.encryptStagingPart(slice, stagingKey, 'sess-1', 0);
    assert.equal(Buffer.compare(cipher.decryptStagingPart(encPart, stagingKey, 'sess-1', 0), slice), 0);
    assert.throws(() => cipher.decryptStagingPart(encPart, stagingKey, 'sess-1', 1));

    const payload = randomBytes(300_000);
    const { transform, iv, keyId } = cipher.createEncryptTransform({
      storageKey: 'field-reports/originals/s/k.enc',
      objectUuid: 'k',
      plaintextSizeBytes: payload.length,
    });

    const encChunks: Buffer[] = [];
    await pipeline(Readable.from(payload), transform, async (src) => {
      for await (const c of src) encChunks.push(c as Buffer);
    });

    const decChunks: Buffer[] = [];
    await pipeline(
      Readable.from(Buffer.concat(encChunks)),
      cipher.createDecryptTransform({
        storageKey: 'field-reports/originals/s/k.enc',
        objectUuid: 'k',
        iv,
        keyId,
        plaintextSizeBytes: payload.length,
      }),
      async (src) => {
        for await (const c of src) decChunks.push(c as Buffer);
      },
    );
    assert.equal(Buffer.compare(Buffer.concat(decChunks), payload), 0);
  });
});

