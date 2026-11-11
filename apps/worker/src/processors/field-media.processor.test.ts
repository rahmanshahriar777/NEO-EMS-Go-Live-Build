import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { UnrecoverableError } from 'bullmq';
import { prisma } from '@ems/database';
import { FieldReportDerivativeKind } from '@ems/shared';
import {
  ChunkedCipherService,
  hasExifGpsIfd,
  loadEncryptionKeyRingFromEnv,
} from '@ems/storage';
import {
  processFieldMediaJob,
  processScanAttachment,
  resolveFieldMediaScanner,
} from './field-media-scan.processor.js';
import { processGenerateDerivatives } from './field-media-transform.processor.js';
import {
  flushFieldReportPreviewAudit,
  purgeAbandonedFieldUploads,
  purgeExpiredFieldReports,
} from './maintenance.processor.js';
import { stubPrisma } from '../test-utils/prisma-stub.helper.js';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCiAnyggAAAAAP/2Q==';

function buildExifOrientation6GpsJpeg(): Buffer {
  const base = Buffer.from(TINY_JPEG_BASE64, 'base64');
  const tiff = Buffer.alloc(68, 0);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  // Orientation = 6 (Rotate 90 CW) -> 32x24 becomes 24x32 after .rotate()
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  // GPSInfoIFDPointer = 38
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(38, 30);
  // GPS IFD at 38
  tiff.writeUInt16LE(2, 38);
  tiff.writeUInt16LE(0x0000, 40);
  tiff.writeUInt16LE(1, 42);
  tiff.writeUInt32LE(4, 44);
  tiff.writeUInt8(2, 48);
  tiff.writeUInt8(3, 49);
  tiff.writeUInt16LE(0x0001, 52);
  tiff.writeUInt16LE(2, 54);
  tiff.writeUInt32LE(2, 56);
  tiff.write('N', 60, 'ascii');

  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4 + app1Payload.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + app1Payload.length, 2);
  app1Payload.copy(app1, 4);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

class MemoryVault {
  objects = new Map<string, Buffer>();
  removed: string[] = [];

  async putBuffer(key: string, buf: Buffer) {
    this.objects.set(key, Buffer.from(buf));
  }
  async getStream(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new Error(`Missing vault key: ${key}`);
    return Readable.from([b]);
  }
  async removeObject(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
  async removeObjects(keys: string[]) {
    for (const k of keys) {
      this.removed.push(k);
      this.objects.delete(k);
    }
  }
}

const cipher = new ChunkedCipherService(
  loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: TEST_KEY }),
);

const ENV_KEYS = [
  'NODE_ENV',
  'FIELD_REPORT_MALWARE_SCAN_ENABLED',
  'CLAMAV_HOST',
  'FIELD_MEDIA_MAX_INPUT_PIXELS',
  'FIELD_MEDIA_MAX_DIMENSION_PX',
  'GDPR_RETENTION_SIGNED_OFF',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('resolveFieldMediaScanner', () => {
  test('fails closed in production when disabled or CLAMAV_HOST missing; uses ClamAvScanner by default', () => {
    assert.throws(
      () =>
        resolveFieldMediaScanner({
          NODE_ENV: 'production',
          FIELD_REPORT_MALWARE_SCAN_ENABLED: 'false',
        }),
      /forbidden in production/i,
    );
    assert.throws(
      () => resolveFieldMediaScanner({ NODE_ENV: 'production' }),
      /CLAMAV_HOST must be configured/i,
    );
    const noop = resolveFieldMediaScanner({
      NODE_ENV: 'development',
      FIELD_REPORT_MALWARE_SCAN_ENABLED: 'false',
    });
    assert.equal(noop.name, 'noop');

    const clam = resolveFieldMediaScanner({ NODE_ENV: 'production', CLAMAV_HOST: 'clamav' });
    assert.equal(clam.name, 'clamav');
  });
});

describe('processScanAttachment (scan-before-process & quarantine)', () => {
  test('quarantines INFECTED file, deletes S3 object, writes audit, notifies author+HR, never transforms', async () => {
    const vault = new MemoryVault();
    const storageKey = 'field-reports/originals/rep-1/att-eicar.enc';
    const eicarBytes = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const enc = cipher.encryptBuffer(eicarBytes, { storageKey, objectUuid: 'att-eicar' });
    await vault.putBuffer(storageKey, enc.ciphertext);

    const updates: any[] = [];
    const auditEntries: any[] = [];
    const mediaJobs: any[] = [];
    const notifJobs: any[] = [];

    const mockDb: any = {
      fieldReportAttachment: {
        findFirst: async () => ({
          id: 'att-eicar',
          reportId: 'rep-1',
          uploadedByUserId: 'user-author',
          mediaKind: 'IMAGE',
          originalFileName: 'eicar.jpg',
          fileSizeBytes: eicarBytes.length,
          checksumSha256: createHash('sha256').update(eicarBytes).digest('hex'),
          storageKey,
          iv: enc.iv,
          keyId: enc.keyId,
          chunkSizeBytes: enc.chunkSizeBytes,
          scanStatus: 'PENDING_SCAN',
          processingStatus: 'PENDING',
          report: {
            reportNumber: 'FR-2026-0009',
            createdByUserId: 'user-author',
            employee: { userId: 'user-author', email: 'a@ems.local', firstName: 'A', lastName: 'B' },
          },
        }),
        update: async (args: any) => updates.push(args),
      },
      user: {
        findMany: async () => [{ id: 'user-hr', email: 'hr@ems.local', employee: null }],
      },
    };

    let scannedBytes = Buffer.alloc(0);
    const fakeScanner: any = {
      name: 'mock-clamav',
      scanStream: async (stream: Readable) => {
        const parts: Buffer[] = [];
        for await (const c of stream) parts.push(Buffer.from(c));
        scannedBytes = Buffer.concat(parts);
        return { clean: false, scanner: 'clamav', threats: ['Eicar-Signature'] };
      },
    };

    const res: any = await processScanAttachment(
      { id: 'j-1', data: { attachmentId: 'att-eicar', reportId: 'rep-1' } } as any,
      {
        db: mockDb,
        vault: vault as any,
        cipher,
        scanner: fakeScanner,
        fieldMediaQueue: { add: async (...args: any[]) => mediaJobs.push(args) } as any,
        notificationsQueue: { add: async (...args: any[]) => notifJobs.push(args) } as any,
        auditWriter: async (entry: any) => auditEntries.push(entry),
      },
    );

    assert.equal(Buffer.compare(scannedBytes, eicarBytes), 0);
    assert.equal(res.scanStatus, 'INFECTED');
    assert.ok(vault.removed.includes(storageKey));
    assert.equal(updates[0].data.scanStatus, 'INFECTED');
    assert.equal(updates[0].data.processingStatus, 'SKIPPED');
    assert.equal(mediaJobs.length, 0, 'infected files must NEVER be queued for transform');
    assert.equal(auditEntries.length, 1);
    assert.equal(notifJobs.length, 2); // author + HR
  });

  test('CLEAN IMAGE schedules generate-derivatives; CLEAN DOCUMENT sets SKIPPED', async () => {
    const vault = new MemoryVault();
    const docKey = 'field-reports/originals/rep-1/doc.enc';
    const docPlain = Buffer.from('%PDF-1.4\nhello');
    const enc = cipher.encryptBuffer(docPlain, { storageKey: docKey, objectUuid: 'att-doc' });
    await vault.putBuffer(docKey, enc.ciphertext);

    const updates: any[] = [];
    const mediaJobs: any[] = [];
    const mockDb: any = {
      fieldReportAttachment: {
        findFirst: async () => ({
          id: 'att-doc',
          reportId: 'rep-1',
          uploadedByUserId: 'u1',
          mediaKind: 'DOCUMENT',
          originalFileName: 'report.pdf',
          fileSizeBytes: docPlain.length,
          checksumSha256: enc.checksumSha256,
          storageKey: docKey,
          iv: enc.iv,
          keyId: enc.keyId,
          chunkSizeBytes: enc.chunkSizeBytes,
          scanStatus: 'PENDING_SCAN',
          processingStatus: 'PENDING',
          report: { reportNumber: 'FR-1', employee: null },
        }),
        update: async (args: any) => updates.push(args),
      },
    };

    const res: any = await processScanAttachment(
      { id: 'j-doc', data: { attachmentId: 'att-doc', reportId: 'rep-1' } } as any,
      {
        db: mockDb,
        vault: vault as any,
        cipher,
        scanner: {
          name: 'clamav',
          scanStream: async (stream: Readable) => {
            for await (const _ of stream) {
              // drain stream completely
            }
            return { clean: true, scanner: 'clamav', threats: [] };
          },
        },
        fieldMediaQueue: { add: async (...args: any[]) => mediaJobs.push(args) } as any,
        notificationsQueue: { add: async () => {} } as any,
        auditWriter: async () => {},
      },
    );
    assert.equal(res.scanStatus, 'CLEAN');
    assert.equal(updates[0].data.processingStatus, 'SKIPPED');
    assert.equal(mediaJobs.length, 0);

    // IMAGE case schedules transform (with its own properly bound ciphertext)
    const imgKey = 'field-reports/originals/rep-1/img.enc';
    const imgPlain = Buffer.from('FAKE-IMAGE-PLAINTEXT-BYTES');
    const encImg = cipher.encryptBuffer(imgPlain, { storageKey: imgKey, objectUuid: 'att-img' });
    await vault.putBuffer(imgKey, encImg.ciphertext);

    mockDb.fieldReportAttachment.findFirst = async () => ({
      id: 'att-img',
      reportId: 'rep-1',
      uploadedByUserId: 'u1',
      mediaKind: 'IMAGE',
      originalFileName: 'photo.jpg',
      fileSizeBytes: imgPlain.length,
      checksumSha256: encImg.checksumSha256,
      storageKey: imgKey,
      iv: encImg.iv,
      keyId: encImg.keyId,
      chunkSizeBytes: encImg.chunkSizeBytes,
      scanStatus: 'PENDING_SCAN',
      processingStatus: 'PENDING',
      report: { reportNumber: 'FR-1', employee: null },
    });
    await processFieldMediaJob(
      { id: 'j-img', name: 'scan-attachment', data: { attachmentId: 'att-img', reportId: 'rep-1' } } as any,
      {
        db: mockDb,
        vault: vault as any,
        cipher,
        scanner: {
          name: 'clamav',
          scanStream: async (stream: Readable) => {
            for await (const _ of stream) {
              // drain stream completely
            }
            return { clean: true, scanner: 'clamav', threats: [] };
          },
        },
        fieldMediaQueue: { add: async (...args: any[]) => mediaJobs.push(args) } as any,
        notificationsQueue: { add: async () => {} } as any,
        auditWriter: async () => {},
      },
    );
    assert.equal(mediaJobs.length, 1);
    assert.equal(mediaJobs[0][0], 'generate-derivatives');
    assert.equal(mediaJobs[0][2].jobId, 'field-transform-att-img');
  });
});

describe('processGenerateDerivatives (real sharp + EXIF GPS strip + bomb guard)', () => {
  test('aborts with UnrecoverableError when scanStatus !== CLEAN', async () => {
    const mockDb: any = {
      fieldReportAttachment: {
        findFirst: async () => ({
          id: 'att-unscanned',
          reportId: 'rep-1',
          scanStatus: 'PENDING_SCAN',
          derivatives: [],
        }),
      },
    };
    await assert.rejects(
      () =>
        processGenerateDerivatives(
          { id: 'j-u', data: { attachmentId: 'att-unscanned', reportId: 'rep-1' } } as any,
          { db: mockDb },
        ),
      UnrecoverableError,
    );
  });

  test('rotates EXIF Orientation=6, strips GPS/EXIF from all 3 sRGB derivatives, and flags hasEmbeddedGps=true on Original', async () => {
    const vault = new MemoryVault();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-test-'));
    try {
      const jpgWithGps = buildExifOrientation6GpsJpeg();
      const origKey = 'field-reports/originals/rep-1/att-gps.enc';
      const enc = cipher.encryptBuffer(jpgWithGps, { storageKey: origKey, objectUuid: 'att-gps' });
      await vault.putBuffer(origKey, enc.ciphertext);

      const upserted: any[] = [];
      const attachmentUpdates: any[] = [];

      const mockDb: any = {
        fieldReportAttachment: {
          findFirst: async () => ({
            id: 'att-gps',
            reportId: 'rep-1',
            mediaKind: 'IMAGE',
            storageKey: origKey,
            iv: enc.iv,
            keyId: enc.keyId,
            chunkSizeBytes: enc.chunkSizeBytes,
            fileSizeBytes: jpgWithGps.length,
            scanStatus: 'CLEAN',
            derivatives: [],
          }),
          update: async (args: any) => attachmentUpdates.push(args),
        },
        fieldReportDerivative: {
          upsert: async (args: any) => upserted.push(args),
        },
      };

      const res: any = await processGenerateDerivatives(
        { id: 'j-t1', data: { attachmentId: 'att-gps', reportId: 'rep-1' } } as any,
        { db: mockDb, vault: vault as any, cipher, tmpDir },
      );

      assert.equal(res.processingStatus, 'READY');
      assert.equal(res.hasEmbeddedGps, true);
      assert.equal(upserted.length, 3);

      const doneUpdate = attachmentUpdates.at(-1).data;
      assert.equal(doneUpdate.widthPx, 32);
      assert.equal(doneUpdate.heightPx, 24);
      assert.equal(doneUpdate.exifOrientation, 6);
      assert.equal(doneUpdate.hasEmbeddedGps, true);

      // Decrypt every derivative and inspect via sharp to prove orientation applied + EXIF/GPS stripped!
      for (const u of upserted) {
        const d = u.create;
        const encBuf = vault.objects.get(d.storageKey)!;
        const plainDeriv = cipher.decryptBuffer(encBuf, {
          storageKey: d.storageKey,
          objectUuid: d.id,
          iv: d.iv,
          keyId: d.keyId,
          plaintextSizeBytes: d.fileSizeBytes,
          chunkSizeBytes: d.chunkSizeBytes,
        });
        const meta = await sharp(plainDeriv).metadata();
        // Orientation=6 on 32x24 => baked pixels become 24x32 with no EXIF!
        assert.equal(meta.width, 24);
        assert.equal(meta.height, 32);
        assert.equal(meta.exif, undefined);
        assert.equal(hasExifGpsIfd(meta.exif), false);
        assert.equal(d.colorspace, 'srgb');
        assert.equal(d.metadataStripped, true);
      }
      assert.ok(
        upserted.some((u) => u.create.kind === FieldReportDerivativeKind.RESIZED_STANDARD),
      );
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('detects pixel bomb limit exceeded -> marks FAILED + UnrecoverableError', async () => {
    process.env.FIELD_MEDIA_MAX_INPUT_PIXELS = '100'; // 32x24 = 768 > 100
    const vault = new MemoryVault();
    const jpg = buildExifOrientation6GpsJpeg();
    const origKey = 'field-reports/originals/rep-1/att-bomb.enc';
    const enc = cipher.encryptBuffer(jpg, { storageKey: origKey, objectUuid: 'att-bomb' });
    await vault.putBuffer(origKey, enc.ciphertext);

    const updates: any[] = [];
    const mockDb: any = {
      fieldReportAttachment: {
        findFirst: async () => ({
          id: 'att-bomb',
          reportId: 'rep-1',
          mediaKind: 'IMAGE',
          storageKey: origKey,
          iv: enc.iv,
          keyId: enc.keyId,
          chunkSizeBytes: enc.chunkSizeBytes,
          fileSizeBytes: jpg.length,
          scanStatus: 'CLEAN',
          derivatives: [],
        }),
        update: async (args: any) => updates.push(args),
      },
      fieldReportDerivative: { upsert: async () => {} },
    };

    await assert.rejects(
      () =>
        processGenerateDerivatives(
          { id: 'j-b', data: { attachmentId: 'att-bomb', reportId: 'rep-1' } } as any,
          { db: mockDb, vault: vault as any, cipher },
        ),
      UnrecoverableError,
    );
    assert.equal(updates.at(-1).data.processingStatus, 'FAILED');
    assert.equal(updates.at(-1).data.processingErrorCode, 'DECOMPRESSION_BOMB_DETECTED');
  });
});

describe('Field Reporting maintenance tasks (abandoned uploads, preview audit flush, retention purge gate)', () => {
  test('purgeAbandonedFieldUploads cleans staging parts & marks expired sessions', async (t) => {
    stubPrisma(
      prisma.fieldReportUploadSession,
      'findMany',
      async () => [
        {
          id: 's-open',
          status: 'OPEN',
          stagingKeyPrefix: 'field-reports/staging/sessions/s-open',
          uploadedChunks: [0, 1],
          updatedAt: new Date(),
        },
        {
          id: 's-old',
          status: 'ABORTED',
          stagingKeyPrefix: 'field-reports/staging/sessions/s-old',
          uploadedChunks: [0],
          updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
      ],
      t,
    );
    const upd = stubPrisma(prisma.fieldReportUploadSession, 'update', async () => ({}), t);
    const del = stubPrisma(prisma.fieldReportUploadSession, 'deleteMany', async () => ({ count: 1 }), t);
    const removedKeys: string[] = [];

    const res: any = await purgeAbandonedFieldUploads(
      { id: 'm1', data: { operation: 'purgeAbandonedFieldUploads' } } as any,
      {
        vault: {
          removeObjects: async (keys: string[]) => {
            removedKeys.push(...keys);
          },
        } as any,
      },
    );

    assert.equal(removedKeys.length, 3);
    assert.equal(upd.calls.length, 1);
    assert.equal(del.calls.length, 1);
    assert.equal(res.expiredMarked, 1);
    assert.equal(res.deletedSessions, 1);
  });

  test('flushFieldReportPreviewAudit drains daily Redis hash atomically into AuditLog rows', async () => {
    const audits: any[] = [];
    const deleted: string[] = [];
    const fakeRedis: any = {
      keys: async () => ['fr:preview_agg:2026-11-11', 'fr:preview_agg:2026-11-11:flushing:old'],
      rename: async () => 'OK',
      hgetall: async () => ({
        'user-1:rep-1': '4',
        'user-1:rep-2': '2',
        'user-2:rep-1': '1',
      }),
      del: async (k: string) => {
        deleted.push(k);
        return 1;
      },
    };

    const res = await flushFieldReportPreviewAudit(
      { id: 'm2', data: { operation: 'flushFieldReportPreviewAudit' } } as any,
      {
        redis: fakeRedis,
        auditWriter: async (entry: any) => audits.push(entry),
      },
    );

    assert.equal(res.flushedBuckets, 1);
    assert.equal(res.auditRowsWritten, 2);
    assert.equal(deleted.length, 1);
    assert.equal(audits[0].entityType, 'FIELD_REPORT_PREVIEW_BATCH');
    assert.equal(audits[0].afterState.totalViews, 6);
  });

  test('purgeExpiredFieldReports enforces dry-run without GDPR_RETENTION_SIGNED_OFF=true, removes S3 objects first when live', async (t) => {
    stubPrisma(
      prisma.fieldReport,
      'findMany',
      async () => [
        {
          id: 'rep-old',
          attachments: [
            {
              storageKey: 'field-reports/originals/rep-old/a1.enc',
              derivatives: [{ storageKey: 'field-reports/derivatives/a1/thumbnail.webp.enc' }],
            },
          ],
        },
      ],
      t,
    );
    const del = stubPrisma(prisma.fieldReport, 'deleteMany', async () => ({ count: 1 }), t);
    const removedKeys: string[] = [];

    // Dry run forced when signoff missing
    const dryRes = await purgeExpiredFieldReports(
      { id: 'm3', data: { operation: 'purgeExpiredFieldReports', dryRun: false } } as any,
      {
        vault: {
          removeObjects: async (keys: string[]) => {
            removedKeys.push(...keys);
          },
        } as any,
      },
    );
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.deleted, 0);
    assert.equal(del.calls.length, 0);
    assert.equal(removedKeys.length, 0);

    // Signed off + dryRun:false => removes S3 objects and deletes DB rows
    process.env.GDPR_RETENTION_SIGNED_OFF = 'true';
    const audits: any[] = [];
    const liveRes = await purgeExpiredFieldReports(
      { id: 'm4', data: { operation: 'purgeExpiredFieldReports', dryRun: false } } as any,
      {
        vault: {
          removeObjects: async (keys: string[]) => {
            removedKeys.push(...keys);
          },
        } as any,
        auditWriter: async (entry: any) => audits.push(entry),
      },
    );
    assert.equal(liveRes.dryRun, false);
    assert.equal(liveRes.deleted, 1);
    assert.equal(liveRes.deletedObjects, 2);
    assert.equal(del.calls.length, 1);
    assert.equal(audits.length, 1);
  });
});
