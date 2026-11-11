// file-type v22 is ESM-only: production Node loads it via dynamic import(),
// while Jest's CJS VM disables import() without --experimental-vm-modules.
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
      if (buf.length >= 2 && buf.subarray(0, 2).toString('latin1') === 'MZ') {
        return { mime: 'application/x-msdownload', ext: 'exe' };
      }
      return undefined;
    }),
  }),
  { virtual: true },
);

import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import {
  FieldMediaScanStatus,
  FieldReportCategory,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  SystemRole,
} from '@ems/shared';
import { ChunkedCipherService, hasExifGpsIfd, loadEncryptionKeyRingFromEnv } from '@ems/storage';
import { QueueService } from '../src/core/queues/queue.service';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { FieldReportsStorageService } from '../src/modules/field-reports/services/field-reports-storage.service';
import {
  InMemoryVaultDouble,
  TEST_DOWNLOAD_SECRET,
  TEST_ENCRYPTION_KEY_1,
  buildExifGpsJpeg,
} from '../src/modules/field-reports/__tests__/test-fixtures';
import { e2eDbOrSkip } from './e2e-utils';

const gate = e2eDbOrSkip('field-reports');

function signFor(jwt: JwtService, config: ConfigService, p: Record<string, any>): string {
  return jwt.sign(p, {
    secret: config.get<string>('jwt.accessSecret'),
    expiresIn: '15m',
  });
}

(gate.available ? describe : describe.skip)(
  'e2e: Field Reporting cross-team isolation, immutable locking & Original fidelity',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwt: JwtService;
    let config: ConfigService;

    const vault = new InMemoryVaultDouble();
    const cipher = new ChunkedCipherService(
      loadEncryptionKeyRingFromEnv({ DOCUMENT_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY_1 }),
    );
    const createdUserIds: string[] = [];
    const createdEmpIds: string[] = [];
    const createdReportIds: string[] = [];

    let mgrAToken: string;
    let mgrBToken: string;
    let empAToken: string;
    let auditorToken: string;

    let mgrAEmpId: string;
    let mgrBEmpId: string;
    let empAEmpId: string;

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = gate.target!.url;
      process.env.JWT_ACCESS_SECRET = 'e2e-test-access-secret';
      process.env.JWT_REFRESH_SECRET = 'e2e-test-refresh-secret';
      process.env.DOCUMENT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_1;
      process.env.FIELD_REPORTS_ENABLED = 'true';
      process.env.FIELD_REPORT_DOWNLOAD_TOKEN_SECRET = TEST_DOWNLOAD_SECRET;

      const { AppModule } = require('../src/app.module');
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(FieldReportsStorageService)
        .useValue({ vault, cipher })
        .overrideProvider(QueueService)
        .useValue({
          enqueueFieldMediaScan: jest.fn().mockResolvedValue(undefined),
          enqueueNotification: jest.fn().mockResolvedValue(undefined),
        })
        .compile();

      app = moduleFixture.createNestApplication();
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();

      prisma = app.get(PrismaService);
      jwt = app.get(JwtService);
      config = app.get(ConfigService);

      const tag = `fr-e2e-${Date.now()}`;
      const mkUser = async (email: string, roleName: SystemRole) => {
        const u = await prisma.user.create({
          data: {
            email,
            passwordHash: 'e2e-not-a-real-hash',
            emailVerified: true,
            isActive: true,
            roles: { create: [{ role: { connect: { name: roleName } } }] },
          },
        });
        createdUserIds.push(u.id);
        return u;
      };

      const mgrAUser = await mkUser(`mgra-${tag}@ems.local`, SystemRole.MANAGER);
      const mgrBUser = await mkUser(`mgrb-${tag}@ems.local`, SystemRole.MANAGER);
      const empAUser = await mkUser(`empa-${tag}@ems.local`, SystemRole.EMPLOYEE);
      const empBUser = await mkUser(`empb-${tag}@ems.local`, SystemRole.EMPLOYEE);
      const audUser = await mkUser(`aud-${tag}@ems.local`, SystemRole.AUDITOR);

      const mkEmp = async (
        firstName: string,
        lastName: string,
        email: string,
        num: string,
        userId: string,
        managerId?: string,
      ) => {
        const e = await prisma.employee.create({
          data: {
            firstName,
            lastName,
            email,
            employeeNumber: num,
            status: 'FULL_TIME',
            userId,
            ...(managerId ? { managerId } : {}),
          },
        });
        createdEmpIds.push(e.id);
        return e;
      };

      const mgrAEmp = await mkEmp('Manager', 'Alpha', `mgra-${tag}@ems.local`, `MGRA-${tag}`, mgrAUser.id);
      const mgrBEmp = await mkEmp('Manager', 'Beta', `mgrb-${tag}@ems.local`, `MGRB-${tag}`, mgrBUser.id);
      const empAEmp = await mkEmp('Emp', 'A1', `empa-${tag}@ems.local`, `EMPA-${tag}`, empAUser.id, mgrAEmp.id);
      await mkEmp('Emp', 'B1', `empb-${tag}@ems.local`, `EMPB-${tag}`, empBUser.id, mgrBEmp.id);

      mgrAEmpId = mgrAEmp.id;
      mgrBEmpId = mgrBEmp.id;
      empAEmpId = empAEmp.id;

      const mgrPerms = [
        'FIELD_REPORT:CREATE',
        'FIELD_REPORT:READ',
        'FIELD_REPORT:UPDATE',
        'FIELD_REPORT:REVIEW',
        'FIELD_REPORT:DOWNLOAD_ORIGINAL',
      ];
      mgrAToken = signFor(jwt, config, {
        sub: mgrAUser.id,
        email: mgrAUser.email,
        employeeId: mgrAEmp.id,
        roles: [SystemRole.MANAGER],
        permissions: mgrPerms,
      });
      mgrBToken = signFor(jwt, config, {
        sub: mgrBUser.id,
        email: mgrBUser.email,
        employeeId: mgrBEmp.id,
        roles: [SystemRole.MANAGER],
        permissions: mgrPerms,
      });
      empAToken = signFor(jwt, config, {
        sub: empAUser.id,
        email: empAUser.email,
        employeeId: empAEmp.id,
        roles: [SystemRole.EMPLOYEE],
        permissions: ['FIELD_REPORT:CREATE', 'FIELD_REPORT:READ', 'FIELD_REPORT:UPDATE', 'FIELD_REPORT:DELETE'],
      });
      auditorToken = signFor(jwt, config, {
        sub: audUser.id,
        email: audUser.email,
        roles: [SystemRole.AUDITOR],
        permissions: ['FIELD_REPORT:READ', 'FIELD_REPORT:REVIEW'], // even misconfigured perms cannot bypass FieldReportAccessService
      });
    }, 60_000);

    afterAll(async () => {
      try {
        if (createdReportIds.length > 0) {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "field_report_revision_attachments" DISABLE TRIGGER ALL;`,
          );
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "field_report_revisions" DISABLE TRIGGER ALL;`,
          );
          try {
            await prisma.fieldReportReview.deleteMany({ where: { reportId: { in: createdReportIds } } });
            await prisma.fieldReportComment.deleteMany({ where: { reportId: { in: createdReportIds } } });
            await prisma.fieldReportUploadSession.deleteMany({ where: { reportId: { in: createdReportIds } } });
            await prisma.fieldReportRevisionAttachment.deleteMany({
              where: { revision: { reportId: { in: createdReportIds } } },
            });
            await prisma.fieldReportDerivative.deleteMany({
              where: { attachment: { reportId: { in: createdReportIds } } },
            });
            await prisma.fieldReportAttachment.deleteMany({ where: { reportId: { in: createdReportIds } } });
            await prisma.fieldReport.deleteMany({ where: { id: { in: createdReportIds } } });
          } finally {
            await prisma.$executeRawUnsafe(
              `ALTER TABLE "field_report_revision_attachments" ENABLE TRIGGER ALL;`,
            );
            await prisma.$executeRawUnsafe(
              `ALTER TABLE "field_report_revisions" ENABLE TRIGGER ALL;`,
            );
          }
        }
        if (createdEmpIds.length > 0) {
          await prisma.employee.deleteMany({ where: { id: { in: createdEmpIds } } });
        }
        if (createdUserIds.length > 0) {
          await prisma.notification.deleteMany({ where: { recipientId: { in: createdUserIds } } });
          await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        }
      } finally {
        await app?.close();
      }
    });

    it('enforces team ACL isolation, live download-grant revocation on manager reassignment, and byte-exact Original download', async () => {
      // 1. Employee A1 creates draft field report
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/field-reports')
        .set('Authorization', `Bearer ${empAToken}`)
        .send({
          title: 'Substation Fence Check',
          notes: 'North gate hinge loose',
          occurredAt: '2026-11-11T09:00:00.000Z',
          category: FieldReportCategory.SITE_INSPECTION,
          gpsConsentGranted: true,
          gpsLatitude: 51.501,
          gpsLongitude: -0.141,
        });
      expect(createRes.status).toBe(201);
      const report = createRes.body.data;
      createdReportIds.push(report.id);
      const revId = report.currentRevisionId;

      // 2. Upload JPEG with EXIF Orientation=6 + GPS IFD
      const origJpeg = buildExifGpsJpeg({ orientation: 6, includeGps: true, padBytes: 4096 });
      const origSha = createHash('sha256').update(origJpeg).digest('hex');

      const sessRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/revisions/${revId}/upload-sessions`)
        .set('Authorization', `Bearer ${empAToken}`)
        .send({
          originalFileName: 'gate_photo.jpg',
          claimedMimeType: 'image/jpeg',
          declaredSizeBytes: origJpeg.length,
          declaredSha256: origSha,
        });
      expect(sessRes.status).toBe(201);
      const { sessionId } = sessRes.body.data;

      const chunkRes = await request(app.getHttpServer())
        .put(`/api/v1/field-reports/upload-sessions/${sessionId}/chunks/0`)
        .set('Authorization', `Bearer ${empAToken}`)
        .set('Content-Type', 'application/octet-stream')
        .set('x-chunk-sha256', origSha)
        .send(origJpeg);
      expect(chunkRes.status).toBe(200);

      const completeRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/upload-sessions/${sessionId}/complete`)
        .set('Authorization', `Bearer ${empAToken}`)
        .send({});
      expect(completeRes.status).toBe(202);
      const { attachmentId } = completeRes.body.data;

      // 3. Submit fails with 409 SCAN_PENDING while PENDING_SCAN, then passes once CLEAN
      const prematureSubmit = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/revisions/${revId}/submit`)
        .set('Authorization', `Bearer ${empAToken}`)
        .send({});
      expect(prematureSubmit.status).toBe(409);

      await prisma.fieldReportAttachment.update({
        where: { id: attachmentId },
        data: { scanStatus: FieldMediaScanStatus.CLEAN },
      });

      const submitRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/revisions/${revId}/submit`)
        .set('Authorization', `Bearer ${empAToken}`)
        .send({});
      expect(submitRes.status).toBe(201);
      expect(submitRes.body.data.currentRevision.submittedManagerSnapshotId).toBe(mgrAEmpId);

      // Locked revision cannot be modified
      const editLocked = await request(app.getHttpServer())
        .patch(`/api/v1/field-reports/${report.id}/revisions/${revId}`)
        .set('Authorization', `Bearer ${empAToken}`)
        .send({ title: 'Tamper attempt' });
      expect(editLocked.status).toBe(409);

      // 4. Manager B (wrong team) and Auditor are strictly isolated with 403
      const mgrBDetail = await request(app.getHttpServer())
        .get(`/api/v1/field-reports/${report.id}`)
        .set('Authorization', `Bearer ${mgrBToken}`);
      expect(mgrBDetail.status).toBe(403);

      const mgrBTeam = await request(app.getHttpServer())
        .get('/api/v1/field-reports/team')
        .set('Authorization', `Bearer ${mgrBToken}`);
      expect(mgrBTeam.status).toBe(200);
      const teamItems = mgrBTeam.body?.data?.items ?? mgrBTeam.body?.data ?? [];
      expect(teamItems.some((r: any) => r.id === report.id)).toBe(false);

      const auditorTeam = await request(app.getHttpServer())
        .get('/api/v1/field-reports/team')
        .set('Authorization', `Bearer ${auditorToken}`);
      expect(auditorTeam.status).toBe(403);

      const auditorDetail = await request(app.getHttpServer())
        .get(`/api/v1/field-reports/${report.id}`)
        .set('Authorization', `Bearer ${auditorToken}`);
      expect(auditorDetail.status).toBe(403);

      // 5. Manager A requesting RESIZED before derivatives are READY gets 409 DERIVATIVES_NOT_READY (never Original)
      const resizedNotReady = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/attachments/${attachmentId}/download-grant`)
        .set('Authorization', `Bearer ${mgrAToken}`)
        .send({ variant: 'RESIZED' });
      expect(resizedNotReady.status).toBe(409);

      // 6. Manager A mints ORIGINAL grant and downloads byte-exact image
      const origGrantRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/attachments/${attachmentId}/download-grant`)
        .set('Authorization', `Bearer ${mgrAToken}`)
        .send({ variant: 'ORIGINAL' });
      expect(origGrantRes.status).toBe(200);
      const { grantToken, downloadUrl } = origGrantRes.body.data;

      // Tampered grant rejected 401
      const tamperedRes = await request(app.getHttpServer()).get(
        `/api/v1/field-reports/downloads?grant=${grantToken}tampered`,
      );
      expect(tamperedRes.status).toBe(401);

      const dlRes = await request(app.getHttpServer())
        .get(downloadUrl)
        .buffer(true)
        .parse((res, cb) => {
          const bufs: Buffer[] = [];
          res.on('data', (d) => bufs.push(Buffer.from(d)));
          res.on('end', () => cb(null, Buffer.concat(bufs)));
        });
      expect(dlRes.status).toBe(200);
      expect(Buffer.compare(dlRes.body, origJpeg)).toBe(0);
      expect(hasExifGpsIfd((dlRes.body as Buffer).subarray(6, 80))).toBe(true);

      // 7. Streamed Bulk ZIP Original works cleanly
      const zipGrantRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/download-zip-grant`)
        .set('Authorization', `Bearer ${mgrAToken}`)
        .send({ variant: FieldReportDownloadVariant.ORIGINAL });
      expect(zipGrantRes.status).toBe(200);

      const zipDlRes = await request(app.getHttpServer())
        .get(zipGrantRes.body.data.downloadUrl)
        .buffer(true)
        .parse((res, cb) => {
          const bufs: Buffer[] = [];
          res.on('data', (d) => bufs.push(Buffer.from(d)));
          res.on('end', () => cb(null, Buffer.concat(bufs)));
        });
      expect(zipDlRes.status).toBe(200);
      expect((zipDlRes.body as Buffer).subarray(0, 4).toString('hex')).toBe('504b0304');

      // 8. Reassign Emp A1 to Manager B -> Manager A's unexpired signed grant is immediately rejected with 403!
      await prisma.employee.update({
        where: { id: empAEmpId },
        data: { managerId: mgrBEmpId },
      });

      const revokedRedeem = await request(app.getHttpServer()).get(downloadUrl);
      expect(revokedRedeem.status).toBe(403);

      // Manager B can now approve
      const approveRes = await request(app.getHttpServer())
        .post(`/api/v1/field-reports/${report.id}/revisions/${revId}/review`)
        .set('Authorization', `Bearer ${mgrBToken}`)
        .send({ decision: FieldReportReviewDecision.APPROVE });
      expect(approveRes.status).toBe(201);
      expect(approveRes.body.data.status).toBe('APPROVED');
    }, 30_000);
  },
);

if (!gate.available) {
  describe('e2e: Field Reporting', () => {
    gate.registerSkip();
  });
}
