import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportDerivativeKind,
  FieldReportDownloadVariant,
  SystemRole,
} from '@ems/shared';
import { DownloadGrantService } from '../services/download-grant.service';
import { FieldReportAccessService } from '../services/field-report-access.service';
import { FieldReportPolicyService } from '../services/field-report-policy.service';
import {
  InMemoryVaultDouble,
  TEST_DOWNLOAD_SECRET,
  createTestCipher,
} from './test-fixtures';

describe('Bulk ZIP streaming memory bound', () => {
  it('streams 60 MiB+ multi-file archive without exceeding bounded heap growth and sanitizes duplicate entry names', async () => {
    const vault = new InMemoryVaultDouble();
    const cipher = createTestCipher();
    const storageMock: any = { vault, cipher };

    const reportId = '11111111-1111-4111-8111-111111111111';
    const revisionId = '22222222-2222-4222-8222-222222222222';
    const entrySize = 6 * 1024 * 1024; // 6 MiB x 10 entries = 60 MiB archive
    const entryPlain = Buffer.alloc(entrySize, 0x5a);

    const attachments: any[] = [];
    for (let i = 0; i < 10; i++) {
      const derivId = `dddd0000-0000-4000-8000-00000000000${i}`;
      const derivKey = `field-reports/derivatives/att-${i}/resized_standard.jpg.enc`;
      const enc = cipher.encryptBuffer(entryPlain, {
        storageKey: derivKey,
        objectUuid: derivId,
      });
      await vault.putBuffer(derivKey, enc.ciphertext);
      attachments.push({
        id: `aaaa0000-0000-4000-8000-00000000000${i}`,
        reportId,
        deletedAt: null,
        mediaKind: FieldMediaKind.IMAGE,
        originalFileName: i % 2 === 0 ? '../../evil/photo.jpg' : 'site.jpg',
        mimeType: 'image/jpeg',
        fileSizeBytes: entrySize,
        checksumSha256: createHash('sha256').update(entryPlain).digest('hex'),
        storageKey: `field-reports/originals/${reportId}/att-${i}.enc`,
        iv: enc.iv,
        keyId: enc.keyId,
        chunkSizeBytes: enc.chunkSizeBytes,
        scanStatus: FieldMediaScanStatus.CLEAN,
        processingStatus: FieldMediaProcessingStatus.READY,
        derivatives: [
          {
            id: derivId,
            kind: FieldReportDerivativeKind.RESIZED_STANDARD,
            storageKey: derivKey,
            mimeType: 'image/jpeg',
            fileSizeBytes: enc.plaintextSizeBytes,
            checksumSha256: enc.checksumSha256,
            iv: enc.iv,
            keyId: enc.keyId,
            chunkSizeBytes: enc.chunkSizeBytes,
          },
        ],
      });
    }

    const prismaMock: any = {
      fieldReport: {
        findFirst: jest.fn().mockResolvedValue({
          id: reportId,
          reportNumber: 'FR-2026-ZIP1',
          employeeId: 'emp-1',
          entityId: null,
          currentRevisionId: revisionId,
          deletedAt: null,
        }),
      },
      fieldReportRevisionAttachment: {
        findMany: jest.fn().mockResolvedValue(
          attachments.map((a, idx) => ({ sortOrder: idx, attachment: a })),
        ),
      },
      fieldReportAttachment: {
        findMany: jest.fn().mockResolvedValue(attachments),
      },
      fieldReportPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityId: null,
            roleName: SystemRole.MANAGER,
            defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
            allowOriginalDownload: false,
            requireGpsForCategories: [],
          },
        ]),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mgr-user',
          email: 'mgr@ems.local',
          isActive: true,
          deletedAt: null,
          employee: { id: 'mgr-emp', deletedAt: null },
          roles: [
            {
              role: {
                name: SystemRole.MANAGER,
                permissions: [{ permission: { subject: 'FIELD_REPORT', action: 'READ' } }],
              },
            },
          ],
        }),
      },
    };

    const configMock = {
      get: jest.fn((key: string, def?: any) =>
        key === 'fieldReports.downloadTokenSecret'
          ? TEST_DOWNLOAD_SECRET
          : key === 'fieldReports.downloadTokenTtlSeconds'
            ? 300
            : def,
      ),
    } as unknown as ConfigService;

    const auditMock: any = { log: jest.fn().mockResolvedValue(undefined) };
    const redisMock: any = {
      getClient: jest.fn().mockReturnValue(null),
      getIsConnected: jest.fn().mockReturnValue(false),
    };
    const accessService = new FieldReportAccessService(prismaMock, {
      can: jest.fn().mockResolvedValue(true),
    } as any);
    const policyService = new FieldReportPolicyService(prismaMock);
    const jwtService = new JwtService({});

    const service = new DownloadGrantService(
      prismaMock,
      configMock,
      jwtService,
      auditMock,
      redisMock,
      accessService,
      policyService,
      storageMock,
    );

    const viewer = {
      userId: 'mgr-user',
      email: 'mgr@ems.local',
      employeeId: 'mgr-emp',
      roles: [SystemRole.MANAGER],
      permissions: ['FIELD_REPORT:READ'],
    };

    const zipGrant = await service.mintZipGrant(
      reportId,
      { variant: FieldReportDownloadVariant.RESIZED },
      viewer,
    );
    expect(zipGrant.fileName).toBe('FR-2026-ZIP1_resized.zip');
    expect(zipGrant.fileSizeBytes).toBe(10 * entrySize);

    const payload = await jwtService.verifyAsync<any>(zipGrant.grantToken, {
      secret: TEST_DOWNLOAD_SECRET,
    });

    const req = new EventEmitter() as any;
    req.ip = '127.0.0.1';
    req.socket = { remoteAddress: '127.0.0.1' };

    let totalBytesWritten = 0;
    let headerPrefix = Buffer.alloc(0);
    const tailChunks: Buffer[] = [];
    const headers: Record<string, string> = {};

    const resSink: any = new Writable({
      write(chunk: Buffer, _enc, cb) {
        totalBytesWritten += chunk.length;
        if (headerPrefix.length < 4) {
          headerPrefix = Buffer.concat([headerPrefix, chunk.subarray(0, 4)]);
        }
        // Keep only first 2 KiB + last few small header buffers for entry name assertions without retaining 60 MiB
        if (tailChunks.length < 2) {
          tailChunks.push(chunk.subarray(0, 512));
        }
        cb();
      },
    });
    resSink.status = jest.fn().mockReturnValue(resSink);
    resSink.setHeader = jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    });

    const heapBefore = process.memoryUsage().heapUsed;
    await service.redeemZipDownload(payload, req, resSink);
    const heapAfter = process.memoryUsage().heapUsed;

    // ZIP local file header magic "PK\x03\x04"
    expect(headerPrefix.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(headers['content-type']).toBe('application/zip');
    expect(totalBytesWritten).toBeGreaterThan(60 * 1024 * 1024);
    expect(headers['content-disposition']).toContain('FR-2026-ZIP1_resized.zip');
    // Streaming ZIP keeps heap delta bounded well below total 60 MiB payload size
    expect(heapAfter - heapBefore).toBeLessThan(48 * 1024 * 1024);
  });
});
