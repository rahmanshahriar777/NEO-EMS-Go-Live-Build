import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ExecutionContext, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportCategory,
  FieldReportDerivativeKind,
  FieldReportDownloadVariant,
  SystemRole,
} from '@ems/shared';
import { DownloadGrantGuard, resolveDownloadTokenSecret } from '../guards/download-grant.guard';
import { DownloadGrantService } from '../services/download-grant.service';
import { FieldReportAccessService } from '../services/field-report-access.service';
import { FieldReportPolicyService } from '../services/field-report-policy.service';
import { InMemoryVaultDouble, TEST_DOWNLOAD_SECRET, createTestCipher } from './test-fixtures';

function makeRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string> = {};
  const res: any = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  res.statusCode = 200;
  res.headers = headers;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.setHeader = jest.fn((k: string, v: string) => {
    headers[k.toLowerCase()] = v;
  });
  res.getBuffer = () => Buffer.concat(chunks);
  return res;
}

describe('FieldReportPolicyService, DownloadGrantGuard & DownloadGrantService', () => {
  describe('resolveDownloadTokenSecret & DownloadGrantGuard', () => {
    it('uses dedicated FIELD_REPORT_DOWNLOAD_TOKEN_SECRET and rejects collision/missing in production', () => {
      const devCfg: any = {
        get: jest.fn((k: string, d?: any) =>
          k === 'jwt.accessSecret' ? 'jwt-secret' : k === 'nodeEnv' ? 'development' : d,
        ),
      };
      const devSecret = resolveDownloadTokenSecret(devCfg);
      expect(devSecret).not.toBe('jwt-secret');
      expect(devSecret).toHaveLength(64);

      const prodBadCfg: any = {
        get: jest.fn((k: string, d?: any) =>
          k === 'fieldReports.downloadTokenSecret'
            ? 'same'
            : k === 'jwt.accessSecret'
              ? 'same'
              : k === 'nodeEnv'
                ? 'production'
                : d,
        ),
      };
      expect(() => resolveDownloadTokenSecret(prodBadCfg)).toThrow(/production/i);
    });

    it('rejects missing, invalid, wrong-purpose, and malformed claims; accepts valid grant', async () => {
      const jwt = new JwtService({});
      const cfg: any = {
        get: jest.fn((k: string, d?: any) =>
          k === 'fieldReports.downloadTokenSecret'
            ? TEST_DOWNLOAD_SECRET
            : k === 'jwt.accessSecret'
              ? 'other-secret'
              : k === 'nodeEnv'
                ? 'test'
                : d,
        ),
      };
      const guard = new DownloadGrantGuard(jwt, cfg);
      const makeCtx = (query: any, reqObj: any = {}): ExecutionContext =>
        ({
          switchToHttp: () => ({
            getRequest: () => Object.assign(reqObj, { query }),
          }),
        }) as any;

      await expect(guard.canActivate(makeCtx({}))).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(makeCtx({ grant: 'not-a-jwt' }))).rejects.toThrow(
        UnauthorizedException,
      );

      const wrongPurpose = await jwt.signAsync(
        { jti: '1', purpose: 'access', scope: 'single', sub: 'u1', reportId: 'r1' },
        { secret: TEST_DOWNLOAD_SECRET, expiresIn: 60 },
      );
      await expect(guard.canActivate(makeCtx({ grant: wrongPurpose }))).rejects.toThrow(
        UnauthorizedException,
      );

      const badScope = await jwt.signAsync(
        { jti: '1', purpose: 'field-report-download', scope: 'all', sub: 'u1', reportId: 'r1' },
        { secret: TEST_DOWNLOAD_SECRET, expiresIn: 60 },
      );
      await expect(guard.canActivate(makeCtx({ grant: badScope }))).rejects.toThrow(
        UnauthorizedException,
      );

      const validToken = await jwt.signAsync(
        {
          jti: '1',
          purpose: 'field-report-download',
          scope: 'single',
          sub: 'u1',
          reportId: 'r1',
          attachmentId: 'a1',
          variant: 'RESIZED',
          disp: 'attachment',
        },
        { secret: TEST_DOWNLOAD_SECRET, expiresIn: 60 },
      );
      const req: any = {};
      await expect(guard.canActivate(makeCtx({ grant: validToken }, req))).resolves.toBe(true);
      expect(req.downloadGrant.sub).toBe('u1');
    });
  });

  describe('FieldReportPolicyService specificity & permission intersection', () => {
    it('prioritizes entity+role > global+role > entity default > global default and intersects FIELD_REPORT:DOWNLOAD_ORIGINAL', async () => {
      const prisma: any = {
        fieldReportPolicy: {
          findMany: jest.fn().mockResolvedValue([
            {
              entityId: null,
              roleName: null,
              defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
              allowOriginalDownload: false,
              requireGpsForCategories: [FieldReportCategory.INCIDENT_SAFETY],
            },
            {
              entityId: 'ent-1',
              roleName: null,
              defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
              allowOriginalDownload: true,
              requireGpsForCategories: [FieldReportCategory.SITE_INSPECTION],
            },
            {
              entityId: null,
              roleName: SystemRole.MANAGER,
              defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
              allowOriginalDownload: true,
              requireGpsForCategories: [],
            },
            {
              entityId: 'ent-1',
              roleName: SystemRole.MANAGER,
              defaultDownloadVariant: FieldReportDownloadVariant.ORIGINAL,
              allowOriginalDownload: true,
              requireGpsForCategories: [],
            },
          ]),
        },
      };

      const svc = new FieldReportPolicyService(prisma);

      // Manager WITH permission in ent-1 gets entity+role ORIGINAL default
      const p1 = await svc.resolveEffectivePolicy(
        { roles: [SystemRole.MANAGER], permissions: ['FIELD_REPORT:DOWNLOAD_ORIGINAL'] },
        'ent-1',
      );
      expect(p1.defaultDownloadVariant).toBe(FieldReportDownloadVariant.ORIGINAL);
      expect(p1.canDownloadOriginal).toBe(true);
      expect(p1.requireGpsForCategories.sort()).toEqual([
        FieldReportCategory.INCIDENT_SAFETY,
        FieldReportCategory.SITE_INSPECTION,
      ]);

      // Manager WITHOUT permission gets allowOriginalDownload=true from policy row, but canDownloadOriginal=false
      const p2 = await svc.resolveEffectivePolicy(
        { roles: [SystemRole.MANAGER], permissions: ['FIELD_REPORT:READ'] },
        'ent-1',
      );
      expect(p2.canDownloadOriginal).toBe(false);
      expect(p2.defaultDownloadVariant).toBe(FieldReportDownloadVariant.RESIZED);

      // Employee with no role row falls back to global default row
      const p3 = await svc.resolveEffectivePolicy(
        { roles: [SystemRole.EMPLOYEE], permissions: ['FIELD_REPORT:DOWNLOAD_ORIGINAL'] },
        null,
      );
      expect(p3.allowOriginalDownload).toBe(false);
      expect(p3.canDownloadOriginal).toBe(false);

      // No policy rows -> safe closed fallback
      prisma.fieldReportPolicy.findMany.mockResolvedValueOnce([]);
      const p4 = await svc.resolveEffectivePolicy(
        { roles: [SystemRole.SUPER_ADMIN], permissions: [] },
        null,
      );
      expect(p4.canDownloadOriginal).toBe(false);
    });
  });

  describe('DownloadGrantService invariants (Resized never falls back to Original, Docs Original-only, live DB invalidation, Range, Preview agg)', () => {
    function buildHarness(overrides: {
      attachment?: any;
      policies?: any[];
      allowAccess?: boolean;
      activeUser?: any;
      redis?: any;
    } = {}) {
      const vault = new InMemoryVaultDouble();
      const cipher = createTestCipher();
      const jwt = new JwtService({});
      const cfg: any = {
        get: jest.fn((k: string, d?: any) =>
          k === 'fieldReports.downloadTokenSecret'
            ? TEST_DOWNLOAD_SECRET
            : k === 'fieldReports.downloadTokenTtlSeconds'
              ? 300
              : k === 'nodeEnv'
                ? 'test'
                : d,
        ),
      };
      const auditMock: any = { log: jest.fn().mockResolvedValue(undefined) };
      const redisMock: any = overrides.redis ?? {
        getClient: jest.fn().mockReturnValue(null),
        getIsConnected: jest.fn().mockReturnValue(false),
      };
      const accessPolicyMock: any = {
        can: jest.fn().mockResolvedValue(overrides.allowAccess ?? true),
      };

      const defaultPolicies = overrides.policies ?? [
        {
          entityId: null,
          roleName: SystemRole.MANAGER,
          defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
          allowOriginalDownload: true,
          requireGpsForCategories: [],
        },
      ];

      const prismaMock: any = {
        fieldReport: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'rep-1',
            reportNumber: 'FR-2026-0100',
            employeeId: 'emp-1',
            entityId: null,
            currentRevisionId: 'rev-1',
            deletedAt: null,
          }),
        },
        fieldReportAttachment: {
          findFirst: jest.fn().mockResolvedValue(overrides.attachment ?? null),
          findMany: jest.fn().mockResolvedValue(
            overrides.attachment ? [overrides.attachment] : [],
          ),
        },
        fieldReportRevisionAttachment: {
          findMany: jest.fn().mockResolvedValue(
            overrides.attachment ? [{ sortOrder: 0, attachment: overrides.attachment }] : [],
          ),
        },
        fieldReportPolicy: {
          findMany: jest.fn().mockResolvedValue(defaultPolicies),
        },
        fieldReportDelegation: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        employee: {
          findFirst: jest.fn().mockResolvedValue({ managerId: 'mgr-emp' }),
        },
        user: {
          findFirst: jest.fn().mockResolvedValue(
            overrides.activeUser !== undefined
              ? overrides.activeUser
              : {
                  id: 'mgr-user',
                  email: 'mgr@ems.local',
                  isActive: true,
                  deletedAt: null,
                  employee: { id: 'mgr-emp', deletedAt: null },
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
                },
          ),
        },
      };

      const accessService = new FieldReportAccessService(prismaMock, accessPolicyMock);
      const policyService = new FieldReportPolicyService(prismaMock);
      const service = new DownloadGrantService(
        prismaMock,
        cfg,
        jwt,
        auditMock,
        redisMock,
        accessService,
        policyService,
        { vault, cipher } as any,
      );

      return { service, prismaMock, accessPolicyMock, auditMock, vault, cipher, jwt };
    }

    const viewer = {
      userId: 'mgr-user',
      email: 'mgr@ems.local',
      employeeId: 'mgr-emp',
      roles: [SystemRole.MANAGER],
      permissions: ['FIELD_REPORT:READ', 'FIELD_REPORT:DOWNLOAD_ORIGINAL'],
    };

    it('returns 409 DERIVATIVES_NOT_READY (NEVER Original) when RESIZED requested before processing finishes', async () => {
      const { service } = buildHarness({
        attachment: {
          id: 'att-1',
          reportId: 'rep-1',
          mediaKind: FieldMediaKind.IMAGE,
          originalFileName: 'photo.heic',
          mimeType: 'image/heic',
          fileSizeBytes: 5000,
          checksumSha256: 'abc',
          storageKey: 'field-reports/originals/rep-1/att-1.enc',
          iv: '00'.repeat(12),
          keyId: 'fp-1',
          chunkSizeBytes: 262_144,
          scanStatus: FieldMediaScanStatus.CLEAN,
          processingStatus: FieldMediaProcessingStatus.PROCESSING,
          derivatives: [],
        },
      });

      await expect(
        service.mintSingleGrant('rep-1', 'att-1', { variant: 'RESIZED' }, viewer),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ error: 'DERIVATIVES_NOT_READY' }),
      });

      await expect(
        service.mintZipGrant('rep-1', { variant: FieldReportDownloadVariant.RESIZED }, viewer),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ error: 'DERIVATIVES_NOT_READY' }),
      });
    });

    it('rejects RESIZED for DOCUMENTS (400 DOCUMENTS_ORIGINAL_ONLY) and allows Document ORIGINAL even when Original image policy is false', async () => {
      const { service } = buildHarness({
        policies: [
          {
            entityId: null,
            roleName: SystemRole.MANAGER,
            defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
            allowOriginalDownload: false,
            requireGpsForCategories: [],
          },
        ],
        attachment: {
          id: 'att-doc',
          reportId: 'rep-1',
          mediaKind: FieldMediaKind.DOCUMENT,
          originalFileName: 'inspection_report.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 1234,
          checksumSha256: 'deadbeef',
          storageKey: 'field-reports/originals/rep-1/att-doc.enc',
          iv: '00'.repeat(12),
          keyId: 'fp-1',
          chunkSizeBytes: 262_144,
          scanStatus: FieldMediaScanStatus.CLEAN,
          processingStatus: FieldMediaProcessingStatus.SKIPPED,
          derivatives: [],
        },
      });

      await expect(
        service.mintSingleGrant('rep-1', 'att-doc', { variant: 'RESIZED' }, viewer),
      ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ error: 'DOCUMENTS_ORIGINAL_ONLY' }),
      });

      const docGrant = await service.mintSingleGrant(
        'rep-1',
        'att-doc',
        { variant: 'ORIGINAL' },
        viewer,
      );
      expect(docGrant.variantServed).toBe('ORIGINAL');
      expect(docGrant.mimeType).toBe('application/pdf');
    });

    it('blocks INFECTED (403) and PENDING_SCAN (409) and enforces policy restriction on IMAGE ORIGINAL (403)', async () => {
      const infectedHarness = buildHarness({
        attachment: {
          id: 'att-inf',
          reportId: 'rep-1',
          mediaKind: FieldMediaKind.IMAGE,
          scanStatus: FieldMediaScanStatus.INFECTED,
          processingStatus: FieldMediaProcessingStatus.SKIPPED,
          derivatives: [],
        },
      });
      await expect(
        infectedHarness.service.mintSingleGrant('rep-1', 'att-inf', { variant: 'ORIGINAL' }, viewer),
      ).rejects.toMatchObject({ status: 403, response: { error: 'SCAN_INFECTED' } });

      const pendingHarness = buildHarness({
        attachment: {
          id: 'att-pend',
          reportId: 'rep-1',
          mediaKind: FieldMediaKind.IMAGE,
          scanStatus: FieldMediaScanStatus.PENDING_SCAN,
          processingStatus: FieldMediaProcessingStatus.PENDING,
          derivatives: [],
        },
      });
      await expect(
        pendingHarness.service.mintSingleGrant('rep-1', 'att-pend', { variant: 'ORIGINAL' }, viewer),
      ).rejects.toMatchObject({ status: 409, response: { error: 'SCAN_PENDING' } });

      const policyBlockedHarness = buildHarness({
        policies: [
          {
            entityId: null,
            roleName: SystemRole.MANAGER,
            defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
            allowOriginalDownload: false,
            requireGpsForCategories: [],
          },
        ],
        attachment: {
          id: 'att-img',
          reportId: 'rep-1',
          mediaKind: FieldMediaKind.IMAGE,
          scanStatus: FieldMediaScanStatus.CLEAN,
          processingStatus: FieldMediaProcessingStatus.READY,
          derivatives: [],
        },
      });
      await expect(
        policyBlockedHarness.service.mintSingleGrant('rep-1', 'att-img', { variant: 'ORIGINAL' }, viewer),
      ).rejects.toMatchObject({ status: 403, response: { error: 'ORIGINAL_DOWNLOAD_DISABLED_BY_POLICY' } });
    });

    it('re-checks live DB ACL & user status on redemption, supports HTTP Range (206 / 416), and aggregates preview views in Redis', async () => {
      const redisClient = {
        set: jest.fn().mockResolvedValue('OK'),
        hincrby: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
      };
      const cipher = createTestCipher();
      const thumbPlain = Buffer.from('WEBP-THUMB-BYTES-0123456789ABCDEF');
      const derivKey = 'field-reports/derivatives/att-1/thumbnail.webp.enc';
      const encThumb = cipher.encryptBuffer(thumbPlain, {
        storageKey: derivKey,
        objectUuid: 'deriv-thumb',
      });

      const att = {
        id: 'att-1',
        reportId: 'rep-1',
        mediaKind: FieldMediaKind.IMAGE,
        originalFileName: 'site (north).jpg',
        mimeType: 'image/jpeg',
        fileSizeBytes: thumbPlain.length,
        checksumSha256: encThumb.checksumSha256,
        storageKey: derivKey,
        iv: encThumb.iv,
        keyId: encThumb.keyId,
        chunkSizeBytes: encThumb.chunkSizeBytes,
        scanStatus: FieldMediaScanStatus.CLEAN,
        processingStatus: FieldMediaProcessingStatus.READY,
        derivatives: [
          {
            id: 'deriv-thumb',
            kind: FieldReportDerivativeKind.THUMBNAIL,
            storageKey: derivKey,
            mimeType: 'image/webp',
            fileSizeBytes: thumbPlain.length,
            checksumSha256: encThumb.checksumSha256,
            iv: encThumb.iv,
            keyId: encThumb.keyId,
            chunkSizeBytes: encThumb.chunkSizeBytes,
          },
        ],
      };

      const harness = buildHarness({
        attachment: att,
        redis: { getClient: () => redisClient, getIsConnected: () => true },
      });
      await harness.vault.putBuffer(derivKey, encThumb.ciphertext);

      const grant = await harness.service.mintSingleGrant(
        'rep-1',
        'att-1',
        { variant: 'THUMBNAIL' },
        viewer,
      );
      const payload = await harness.jwt.verifyAsync<any>(grant.grantToken, {
        secret: TEST_DOWNLOAD_SECRET,
      });

      const req: any = Object.assign(new EventEmitter(), {
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      });
      const res206 = makeRes();
      await harness.service.redeemSingleDownload(payload, 'bytes=5-14', req, res206);
      expect(res206.statusCode).toBe(HttpStatus.PARTIAL_CONTENT);
      expect(res206.headers['content-range']).toBe(`bytes 5-14/${thumbPlain.length}`);
      expect(res206.getBuffer().toString()).toBe(thumbPlain.subarray(5, 15).toString());
      expect(redisClient.hincrby).toHaveBeenCalledTimes(1);
      // Previews aggregate in Redis instead of calling AuditService directly
      expect(harness.auditMock.log).not.toHaveBeenCalled();

      // Suffix range bytes=-6
      const resSuffix = makeRes();
      await harness.service.redeemSingleDownload(payload, 'bytes=-6', req, resSuffix);
      expect(resSuffix.statusCode).toBe(206);
      expect(resSuffix.getBuffer().toString()).toBe(thumbPlain.subarray(-6).toString());

      // Out-of-bounds range -> 416
      const res416 = makeRes();
      await expect(
        harness.service.redeemSingleDownload(payload, 'bytes=9999-10000', req, res416),
      ).rejects.toMatchObject({ status: 416 });
      expect(res416.headers['content-range']).toBe(`bytes */${thumbPlain.length}`);

      // Revoking manager ACL invalidates still-unexpired signed grant immediately!
      harness.accessPolicyMock.can.mockResolvedValueOnce(false);
      await expect(
        harness.service.redeemSingleDownload(payload, undefined, req, makeRes()),
      ).rejects.toMatchObject({ status: 403 });

      // Deactivating user rejects with 401
      harness.prismaMock.user.findFirst.mockResolvedValueOnce(null);
      await expect(
        harness.service.redeemSingleDownload(payload, undefined, req, makeRes()),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('aborts Original stream if decrypted plaintext fails SHA-256 verification', async () => {
      const harness = buildHarness();
      const origKey = 'field-reports/originals/rep-1/att-sha.enc';
      const plain = Buffer.from('ORIGINAL-BYTES-FOR-SHA-CHECK');
      const enc = harness.cipher.encryptBuffer(plain, {
        storageKey: origKey,
        objectUuid: 'att-sha',
      });
      await harness.vault.putBuffer(origKey, enc.ciphertext);

      harness.prismaMock.fieldReportAttachment.findFirst.mockResolvedValue({
        id: 'att-sha',
        reportId: 'rep-1',
        mediaKind: FieldMediaKind.IMAGE,
        originalFileName: 'check.jpg',
        mimeType: 'image/jpeg',
        fileSizeBytes: plain.length,
        checksumSha256: createHash('sha256').update('DIFFERENT').digest('hex'),
        storageKey: origKey,
        iv: enc.iv,
        keyId: enc.keyId,
        chunkSizeBytes: enc.chunkSizeBytes,
        scanStatus: FieldMediaScanStatus.CLEAN,
        processingStatus: FieldMediaProcessingStatus.READY,
        derivatives: [],
      });

      const payload: any = {
        jti: '1',
        purpose: 'field-report-download',
        scope: 'single',
        sub: 'mgr-user',
        reportId: 'rep-1',
        attachmentId: 'att-sha',
        variant: 'ORIGINAL',
        disp: 'attachment',
      };
      const req: any = Object.assign(new EventEmitter(), {
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      });
      await expect(
        harness.service.redeemSingleDownload(payload, undefined, req, makeRes()),
      ).rejects.toThrow(/checksum mismatch/i);
    });
  });
});
