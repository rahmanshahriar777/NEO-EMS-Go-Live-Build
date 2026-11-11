// file-type v22 is ESM-only: production Node loads it via dynamic import(),
// while Jest's CJS VM disables import() without --experimental-vm-modules.
// Mirror exact magic-byte signatures so detectFieldMediaMime tests real sniffing.
jest.mock(
  'file-type',
  () => ({
    fileTypeFromBuffer: jest.fn(async (buf: Buffer) => {
      if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { mime: 'image/jpeg', ext: 'jpg' };
      }
      if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { mime: 'image/png', ext: 'png' };
      }
      if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') {
        return { mime: 'application/pdf', ext: 'pdf' };
      }
      if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buf.subarray(8, 12).toString('ascii');
        if (brand === 'heic' || brand === 'heix' || brand === 'mif1') {
          return { mime: 'image/heic', ext: 'heic' };
        }
      }
      if (buf.length >= 2 && buf.subarray(0, 2).toString('latin1') === 'MZ') {
        return { mime: 'application/x-msdownload', ext: 'exe' };
      }
      return undefined;
    }),
  }),
  { virtual: true },
);

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AuditAction,
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportDownloadVariant,
  FieldReportStatus,
  SystemRole,
  UploadSessionStatus,
} from '@ems/shared';
import { hasExifGpsIfd } from '@ems/storage';
import { UploadSessionService } from '../services/upload-session.service';
import { DownloadGrantService } from '../services/download-grant.service';
import { FieldReportAccessService } from '../services/field-report-access.service';
import { FieldReportPolicyService } from '../services/field-report-policy.service';
import {
  InMemoryVaultDouble,
  TEST_DOWNLOAD_SECRET,
  TEST_ENCRYPTION_KEY_1,
  buildExifGpsJpeg,
  createTestCipher,
} from './test-fixtures';

class MockExpressResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];
  writableEnded = false;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  asWritableStream(): Writable {
    const self = this;
    return new Writable({
      write(chunk, _enc, cb) {
        self.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
      final(cb) {
        self.writableEnded = true;
        self.emit('finish');
        cb();
      },
    }) as any;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

describe('Original image upload -> chunked encryption -> download roundtrip', () => {
  it('preserves bit-exact bytes (EXIF & GPS IFD intact) across multi-chunk upload & streamed Original download', async () => {
    const originalJpeg = buildExifGpsJpeg({
      orientation: 6,
      includeGps: true,
      padBytes: 640_000, // ~640 KB -> spans multiple 256 KiB GCM chunks & multiple upload chunks
    });
    const originalSha256 = createHash('sha256').update(originalJpeg).digest('hex');
    expect(hasExifGpsIfd(originalJpeg.subarray(6, 80))).toBe(true);

    const vault = new InMemoryVaultDouble();
    const cipher = createTestCipher(TEST_ENCRYPTION_KEY_1);
    const storageMock: any = { vault, cipher };

    const reportId = '11111111-1111-4111-8111-111111111111';
    const revisionId = '22222222-2222-4222-8222-222222222222';
    const authorUserId = '33333333-3333-4333-8333-333333333333';
    const authorEmployeeId = '44444444-4444-4444-8444-444444444444';
    const managerUserId = '55555555-5555-4555-8555-555555555555';
    const managerEmployeeId = '66666666-6666-4666-8666-666666666666';

    let storedSession: any = null;
    let storedAttachment: any = null;
    const auditLogs: any[] = [];

    const prismaMock: any = {
      fieldReportRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: revisionId,
          reportId,
          revisionNumber: 1,
          status: FieldReportStatus.DRAFT,
          lockedAt: null,
          report: {
            id: reportId,
            employeeId: authorEmployeeId,
            createdByUserId: authorUserId,
            status: FieldReportStatus.DRAFT,
          },
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: revisionId,
          revisionNumber: 1,
          status: FieldReportStatus.DRAFT,
          lockedAt: null,
        }),
      },
      fieldReportRevisionAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      fieldReportAttachment: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          if (storedAttachment && where?.id === storedAttachment.id) {
            return { ...storedAttachment, derivatives: [] };
          }
          return null;
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          storedAttachment = { ...data, createdAt: new Date() };
          return storedAttachment;
        }),
      },
      fieldReportUploadSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          storedSession = { ...data, uploadedChunks: [] };
          return storedSession;
        }),
        findUnique: jest.fn().mockImplementation(async () => storedSession),
        updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
          if (!storedSession || storedSession.status !== UploadSessionStatus.OPEN) return { count: 0 };
          storedSession.status = data.status;
          return { count: 1 };
        }),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          storedSession = { ...storedSession, ...data };
          return storedSession;
        }),
      },
      $queryRaw: jest.fn().mockImplementation(async (_strings: any, idx: number) => {
        if (!storedSession.uploadedChunks.includes(idx)) {
          storedSession.uploadedChunks.push(idx);
          storedSession.uploadedChunks.sort((a: number, b: number) => a - b);
        }
        return [{ uploadedChunks: storedSession.uploadedChunks }];
      }),
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prismaMock)),
      fieldReport: {
        findFirst: jest.fn().mockResolvedValue({
          id: reportId,
          reportNumber: 'FR-2026-0099',
          employeeId: authorEmployeeId,
          entityId: null,
          deletedAt: null,
        }),
      },
      fieldReportPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityId: null,
            roleName: SystemRole.MANAGER,
            defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
            allowOriginalDownload: true,
            requireGpsForCategories: [],
          },
        ]),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: managerUserId,
          email: 'manager@ems.local',
          isActive: true,
          deletedAt: null,
          employee: { id: managerEmployeeId, deletedAt: null },
          roles: [
            {
              role: {
                name: SystemRole.MANAGER,
                permissions: [
                  { permission: { subject: 'FIELD_REPORT', action: 'READ' } },
                  { permission: { subject: 'FIELD_REPORT', action: 'DOWNLOAD_ORIGINAL' } },
                ],
              },
            },
          ],
        }),
      },
    };

    const configValues: Record<string, any> = {
      'fieldReports.maxFileSizeBytes': 52_428_800,
      'fieldReports.maxFilesPerRevision': 20,
      'fieldReports.maxTotalBytesPerRevision': 262_144_000,
      'fieldReports.chunkSizeBytes': 300_000, // Force 3 upload chunks
      'fieldReports.allowedMimeTypes': ['image/jpeg', 'image/png', 'application/pdf'],
      'fieldReports.downloadTokenSecret': TEST_DOWNLOAD_SECRET,
      'fieldReports.downloadTokenTtlSeconds': 300,
      nodeEnv: 'test',
    };
    const configMock = {
      get: jest.fn((key: string, def?: any) =>
        key in configValues ? configValues[key] : def,
      ),
    } as unknown as ConfigService;

    const auditMock: any = {
      log: jest.fn().mockImplementation(async (entry: any) => {
        auditLogs.push(entry);
      }),
    };
    const queueMock: any = {
      enqueueFieldMediaScan: jest.fn().mockResolvedValue(undefined),
    };
    const accessPolicyMock: any = {
      can: jest.fn().mockResolvedValue(true),
    };
    const redisMock: any = {
      getClient: jest.fn().mockReturnValue(null),
      getIsConnected: jest.fn().mockReturnValue(false),
    };

    const uploadService = new UploadSessionService(
      prismaMock,
      configMock,
      auditMock,
      queueMock,
      storageMock,
    );

    const authorViewer = {
      userId: authorUserId,
      email: 'author@ems.local',
      employeeId: authorEmployeeId,
      roles: [SystemRole.EMPLOYEE],
      permissions: ['FIELD_REPORT:CREATE', 'FIELD_REPORT:READ'],
    };

    const session = await uploadService.createSession(
      reportId,
      revisionId,
      {
        originalFileName: '../../DCIM/site_photo_gps.jpg',
        claimedMimeType: 'image/jpeg',
        declaredSizeBytes: originalJpeg.length,
        declaredSha256: originalSha256,
        clientCaptureId: '77777777-7777-4777-8777-777777777777',
      },
      authorViewer,
    );

    expect(session.totalChunks).toBe(3);

    for (let i = 0; i < session.totalChunks!; i++) {
      const start = i * 300_000;
      const end = Math.min(originalJpeg.length, (i + 1) * 300_000);
      const part = originalJpeg.subarray(start, end);
      const partSha = createHash('sha256').update(part).digest('hex');
      await uploadService.uploadChunk(session.sessionId!, i, part, authorViewer, partSha);
    }

    const completed = await uploadService.completeSession(
      session.sessionId!,
      authorViewer,
      '10.0.0.5',
    );
    expect(completed.mimeType).toBe('image/jpeg');
    expect(completed.mediaKind).toBe(FieldMediaKind.IMAGE);
    expect(completed.checksumSha256).toBe(originalSha256);
    expect(completed.scanStatus).toBe(FieldMediaScanStatus.PENDING_SCAN);
    expect(queueMock.enqueueFieldMediaScan).toHaveBeenCalledWith(
      completed.attachmentId,
      reportId,
    );
    // Staging parts cleaned up
    expect(
      Array.from(vault.objects.keys()).filter((k) => k.includes('/staging/')),
    ).toHaveLength(0);

    // Encrypted at rest: MinIO ciphertext must differ from plaintext JPEG!
    const storedCipher = await vault.getBuffer(storedAttachment.storageKey);
    expect(storedCipher.includes(Buffer.from('Exif'))).toBe(false);

    // Simulate worker marking malware scan CLEAN
    storedAttachment.scanStatus = FieldMediaScanStatus.CLEAN;
    storedAttachment.processingStatus = FieldMediaProcessingStatus.READY;

    const accessService = new FieldReportAccessService(prismaMock, accessPolicyMock);
    const policyService = new FieldReportPolicyService(prismaMock);
    const jwtService = new JwtService({});
    const downloadService = new DownloadGrantService(
      prismaMock,
      configMock,
      jwtService,
      auditMock,
      redisMock,
      accessService,
      policyService,
      storageMock,
    );

    const managerViewer = {
      userId: managerUserId,
      email: 'manager@ems.local',
      employeeId: managerEmployeeId,
      roles: [SystemRole.MANAGER],
      permissions: ['FIELD_REPORT:READ', 'FIELD_REPORT:DOWNLOAD_ORIGINAL'],
    };

    const grant = await downloadService.mintSingleGrant(
      reportId,
      completed.attachmentId,
      { variant: 'ORIGINAL' },
      managerViewer,
    );
    expect(grant.variantServed).toBe('ORIGINAL');
    expect(grant.fileName).toBe('site_photo_gps.jpg');
    expect(grant.fileSizeBytes).toBe(originalJpeg.length);

    const verifiedPayload = await jwtService.verifyAsync<any>(grant.grantToken, {
      secret: TEST_DOWNLOAD_SECRET,
    });
    expect(verifiedPayload.purpose).toBe('field-report-download');

    // Mock Express request/response
    const mockReq = new EventEmitter() as any;
    mockReq.ip = '10.0.0.99';
    mockReq.socket = { remoteAddress: '10.0.0.99' };

    const chunks: Buffer[] = [];
    const resSink = new MockExpressResponse();
    const resMock: any = Object.assign(resSink.asWritableStream(), {
      status: resSink.status.bind(resSink),
      setHeader: resSink.setHeader.bind(resSink),
    });
    resMock.on('data', (d: Buffer) => chunks.push(d));

    await downloadService.redeemSingleDownload(verifiedPayload, undefined, mockReq, resMock);

    const downloadedBytes = resSink.toBuffer();
    expect(resSink.statusCode).toBe(200);
    expect(resSink.headers['cache-control']).toBe('private, no-store');
    expect(resSink.headers['x-content-type-options']).toBe('nosniff');
    expect(downloadedBytes.length).toBe(originalJpeg.length);
    expect(Buffer.compare(downloadedBytes, originalJpeg)).toBe(0);
    // EXIF & GPS intact in Original
    expect(hasExifGpsIfd(downloadedBytes.subarray(6, 80))).toBe(true);
    // Audit log recorded for Original download
    expect(
      auditLogs.some(
        (a) =>
          a.action === AuditAction.DOCUMENT_DOWNLOAD &&
          a.entityType === 'FIELD_REPORT_ATTACHMENT' &&
          a.afterState?.variant === 'ORIGINAL' &&
          a.afterState?.checksumVerified === true,
      ),
    ).toBe(true);
  });
});
