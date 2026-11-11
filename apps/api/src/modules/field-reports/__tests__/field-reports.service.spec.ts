import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  AuditAction,
  FieldMediaKind,
  FieldMediaProcessingStatus,
  FieldMediaScanStatus,
  FieldReportCategory,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  FieldReportStatus,
  SystemRole,
  UploadSessionStatus,
} from '@ems/shared';
import { FieldReportsController } from '../field-reports.controller';
import { FieldReportFeatureGuard } from '../guards/field-report-feature.guard';
import { FieldReportAccessService } from '../services/field-report-access.service';
import { FieldReportsService } from '../services/field-reports.service';
import { UploadSessionService } from '../services/upload-session.service';
import { InMemoryVaultDouble, createTestCipher } from './test-fixtures';

describe('FieldReportFeatureGuard, FieldReportAccessService, FieldReportsService, UploadSessionService & Controller', () => {
  describe('FieldReportFeatureGuard', () => {
    it('returns 404 FEATURE_DISABLED when flag is false, and allows when true', () => {
      const disabled = new FieldReportFeatureGuard({ get: () => false } as any);
      expect(() => disabled.canActivate({} as any)).toThrow(NotFoundException);

      const enabled = new FieldReportFeatureGuard({ get: () => true } as any);
      expect(enabled.canActivate({} as any)).toBe(true);
    });
  });

  describe('FieldReportAccessService', () => {
    function buildAccess(canResult = false, delegation: any = null) {
      const prisma: any = {
        employee: { findFirst: jest.fn().mockResolvedValue({ managerId: 'mgr-1' }) },
        fieldReportDelegation: {
          findFirst: jest.fn().mockResolvedValue(delegation),
          findMany: jest.fn().mockResolvedValue(delegation ? [delegation] : []),
        },
      };
      const policy: any = { can: jest.fn().mockResolvedValue(canResult) };
      return { svc: new FieldReportAccessService(prisma, policy), prisma, policy };
    }

    it('excludes AUDITOR-only viewers even if policy returns true, allows delegates and HR, blocks self-review', async () => {
      const { svc } = buildAccess(true, null);
      const auditor = { userId: 'u-aud', roles: [SystemRole.AUDITOR], permissions: [] };
      expect(await svc.canRead(auditor, { employeeId: 'emp-1', entityId: null })).toEqual({
        allowed: false,
        actedAsDelegateForId: null,
      });
      await expect(
        svc.assertCanReview(auditor, { employeeId: 'emp-1', entityId: null }),
      ).rejects.toThrow(ForbiddenException);

      // Self review forbidden even if HR_ADMIN
      const selfHr = {
        userId: 'u-1',
        employeeId: 'emp-1',
        roles: [SystemRole.HR_ADMIN],
        permissions: ['FIELD_REPORT:REVIEW'],
      };
      await expect(
        svc.assertCanReview(selfHr, { employeeId: 'emp-1', entityId: null }),
      ).rejects.toThrow(/own field report/i);

      // HR can review other employees
      expect(
        await svc.assertCanReview(selfHr, { employeeId: 'emp-2', entityId: null }),
      ).toEqual({ actedAsDelegateForId: null });

      // Delegate access works when direct manager ACL returns false
      const delAccess = buildAccess(false, { delegatorEmployeeId: 'mgr-1', entityId: null });
      const delegate = {
        userId: 'u-del',
        employeeId: 'emp-del',
        roles: [SystemRole.MANAGER],
        permissions: ['FIELD_REPORT:READ', 'FIELD_REPORT:REVIEW'],
      };
      expect(
        await delAccess.svc.assertCanRead(delegate, { employeeId: 'emp-1', entityId: null }),
      ).toEqual({ actedAsDelegateForId: 'mgr-1' });
      expect(
        await delAccess.svc.assertCanReview(delegate, { employeeId: 'emp-1', entityId: null }),
      ).toEqual({ actedAsDelegateForId: 'mgr-1' });
    });
  });

  describe('FieldReportsService workflow & manager routing', () => {
    function buildServiceHarness() {
      const prisma: any = {
        employee: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'emp-author',
            userId: 'user-author',
            entityId: 'ent-1',
            managerId: 'emp-mgr',
            firstName: 'Alex',
            lastName: 'Field',
            manager: {
              id: 'emp-mgr',
              userId: 'user-mgr',
              email: 'mgr@ems.local',
              firstName: 'Morgan',
              lastName: 'Boss',
              deletedAt: null,
            },
          }),
          findUnique: jest.fn().mockResolvedValue({ entityId: 'ent-1' }),
        },
        site: {
          findUnique: jest.fn().mockResolvedValue({ id: 'site-1', name: 'North' }),
          findMany: jest.fn().mockResolvedValue([{ id: 'site-1', name: 'North' }]),
        },
        user: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'user-hr', email: 'hr@ems.local', employee: { entityId: 'ent-1' } },
          ]),
        },
        leaveRequest: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        fieldReport: {
          create: jest.fn().mockResolvedValue({ id: 'rep-1', reportNumber: 'FR-2026-0001' }),
          update: jest.fn().mockResolvedValue({}),
          findFirst: jest.fn(),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        fieldReportRevision: {
          create: jest.fn().mockResolvedValue({ id: 'rev-1', revisionNumber: 1 }),
          findFirst: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
        },
        fieldReportRevisionAttachment: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        fieldReportReview: {
          create: jest.fn().mockResolvedValue({ id: 'revw-1' }),
        },
        fieldReportComment: {
          create: jest.fn().mockResolvedValue({ id: 'cmt-1', body: 'Looks clear' }),
        },
        fieldReportPolicy: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({ id: 'pol-1' }),
          update: jest.fn().mockResolvedValue({ id: 'pol-1' }),
        },
        fieldReportDelegation: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: 'del-1' }),
          update: jest.fn().mockResolvedValue({ id: 'del-1', isActive: false }),
        },
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: 1 }]),
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
      };

      const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
      const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
      const accessPolicy: any = { can: jest.fn().mockResolvedValue(true) };
      const access = new FieldReportAccessService(prisma, accessPolicy);
      const policy: any = {
        resolveEffectivePolicy: jest.fn().mockResolvedValue({
          defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
          allowOriginalDownload: true,
          hasDownloadOriginalPermission: true,
          canDownloadOriginal: true,
          requireGpsForCategories: [],
        }),
      };

      const svc = new FieldReportsService(prisma, audit, notifications, access, policy);
      return { svc, prisma, audit, notifications, policy };
    }

    const authorViewer = {
      userId: 'user-author',
      email: 'author@ems.local',
      employeeId: 'emp-author',
      roles: [SystemRole.EMPLOYEE],
      permissions: ['FIELD_REPORT:CREATE', 'FIELD_REPORT:READ', 'FIELD_REPORT:UPDATE', 'FIELD_REPORT:DELETE'],
    };

    const managerViewer = {
      userId: 'user-mgr',
      email: 'mgr@ems.local',
      employeeId: 'emp-mgr',
      roles: [SystemRole.MANAGER],
      permissions: ['FIELD_REPORT:READ', 'FIELD_REPORT:REVIEW'],
    };

    it('enforces GPS consent rules on create and updateRevision, and revoking GPS clears coords', async () => {
      const { svc, prisma } = buildServiceHarness();
      await expect(
        svc.create(
          {
            title: 'Site check',
            occurredAt: '2026-11-11T08:00:00Z',
            category: FieldReportCategory.SITE_INSPECTION,
            gpsConsentGranted: false,
            gpsLatitude: 51.5,
            gpsLongitude: -0.1,
          } as any,
          authorViewer,
        ),
      ).rejects.toThrow(BadRequestException);

      prisma.fieldReport.findFirst.mockResolvedValue({
        id: 'rep-1',
        reportNumber: 'FR-2026-0001',
        employeeId: 'emp-author',
        createdByUserId: 'user-author',
        entityId: 'ent-1',
        status: FieldReportStatus.DRAFT,
        currentRevisionId: 'rev-1',
        currentRevisionNumber: 1,
        legalHold: false,
        revisions: [],
        reviews: [],
        comments: [],
        employee: { id: 'emp-author', managerId: 'emp-mgr' },
      });

      const created = await svc.create(
        {
          title: 'Initial inspection',
          occurredAt: '2026-11-11T08:00:00Z',
          category: FieldReportCategory.SITE_INSPECTION,
          siteId: 'site-1',
          gpsConsentGranted: true,
          gpsLatitude: 51.501,
          gpsLongitude: -0.141,
        },
        authorViewer,
      );
      expect(created.reportNumber).toBe('FR-2026-0001');

      // Revoking GPS consent on updateRevision clears coordinates
      prisma.fieldReportRevision.findFirst.mockResolvedValue({
        id: 'rev-1',
        reportId: 'rep-1',
        revisionNumber: 1,
        status: FieldReportStatus.DRAFT,
        lockedAt: null,
        gpsConsentGranted: true,
        gpsLatitude: 51.501,
        gpsLongitude: -0.141,
        report: { id: 'rep-1', employeeId: 'emp-author', createdByUserId: 'user-author', category: FieldReportCategory.SITE_INSPECTION },
      });

      await svc.updateRevision(
        'rep-1',
        'rev-1',
        { gpsConsentGranted: false },
        authorViewer,
      );
      expect(prisma.fieldReportRevision.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gpsConsentGranted: false,
            gpsLatitude: null,
            gpsLongitude: null,
          }),
        }),
      );
    });

    it('blocks submit when scan is INFECTED/PENDING or GPS_REQUIRED missing, routes unassigned manager to HR, and locks revision', async () => {
      const { svc, prisma, notifications, policy } = buildServiceHarness();

      const makeSubmittableRev = (attachments: any[], gps = false) => ({
        id: 'rev-1',
        reportId: 'rep-1',
        revisionNumber: 1,
        title: 'Hazard photo',
        status: FieldReportStatus.DRAFT,
        lockedAt: null,
        gpsConsentGranted: gps,
        gpsLatitude: gps ? 51.5 : null,
        gpsLongitude: gps ? -0.1 : null,
        report: {
          id: 'rep-1',
          reportNumber: 'FR-2026-0001',
          employeeId: 'emp-author',
          createdByUserId: 'user-author',
          entityId: 'ent-1',
          currentRevisionId: 'rev-1',
          category: FieldReportCategory.INCIDENT_SAFETY,
        },
        attachmentLinks: attachments.map((a) => ({ attachment: a })),
      });

      prisma.fieldReportRevision.findFirst.mockResolvedValueOnce(
        makeSubmittableRev([{ id: 'att-bad', scanStatus: FieldMediaScanStatus.INFECTED, deletedAt: null }]),
      );
      await expect(svc.submitRevision('rep-1', 'rev-1', authorViewer)).rejects.toThrow(
        ForbiddenException,
      );

      prisma.fieldReportRevision.findFirst.mockResolvedValueOnce(
        makeSubmittableRev([{ id: 'att-pend', scanStatus: FieldMediaScanStatus.PENDING_SCAN, deletedAt: null }]),
      );
      await expect(svc.submitRevision('rep-1', 'rev-1', authorViewer)).rejects.toThrow(
        ConflictException,
      );

      policy.resolveEffectivePolicy.mockResolvedValueOnce({
        defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
        allowOriginalDownload: true,
        hasDownloadOriginalPermission: true,
        canDownloadOriginal: true,
        requireGpsForCategories: [FieldReportCategory.INCIDENT_SAFETY],
      });
      prisma.fieldReportRevision.findFirst.mockResolvedValueOnce(
        makeSubmittableRev([{ id: 'att-ok', scanStatus: FieldMediaScanStatus.CLEAN, deletedAt: null }], false),
      );
      await expect(svc.submitRevision('rep-1', 'rev-1', authorViewer)).rejects.toThrow(
        BadRequestException,
      );

      // Valid submission with unassigned manager escalates to HR_ADMIN
      prisma.employee.findFirst.mockResolvedValueOnce({
        id: 'emp-author',
        firstName: 'Alex',
        lastName: 'Field',
        manager: null,
      });
      prisma.fieldReportRevision.findFirst.mockResolvedValueOnce(
        makeSubmittableRev([{ id: 'att-ok', scanStatus: FieldMediaScanStatus.CLEAN, deletedAt: null }], true),
      );
      prisma.fieldReport.findFirst.mockResolvedValue({
        id: 'rep-1',
        reportNumber: 'FR-2026-0001',
        employeeId: 'emp-author',
        createdByUserId: 'user-author',
        entityId: 'ent-1',
        status: FieldReportStatus.SUBMITTED,
        currentRevisionId: 'rev-1',
        currentRevisionNumber: 1,
        legalHold: false,
        revisions: [],
        reviews: [],
        comments: [],
        employee: { id: 'emp-author', managerId: null },
      });

      const res: any = await svc.submitRevision('rep-1', 'rev-1', authorViewer);
      expect(res.routing).toBe('HR_ESCALATION');
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-hr', template: 'field-report-submitted' }),
      );
    });

    it('enforces review REASON_REQUIRED on reject/changes and forks new revision excluding infected attachments', async () => {
      const { svc, prisma, audit, notifications } = buildServiceHarness();

      prisma.fieldReportRevision.findFirst.mockResolvedValue({
        id: 'rev-1',
        reportId: 'rep-1',
        title: 'Safety check',
        status: FieldReportStatus.SUBMITTED,
        report: {
          id: 'rep-1',
          reportNumber: 'FR-2026-0001',
          employeeId: 'emp-author',
          createdByUserId: 'user-author',
          entityId: 'ent-1',
          employee: { id: 'emp-author', userId: 'user-author', email: 'author@ems.local' },
        },
      });

      await expect(
        svc.reviewRevision(
          'rep-1',
          'rev-1',
          { decision: FieldReportReviewDecision.REJECT, reason: 'no' },
          managerViewer,
        ),
      ).rejects.toThrow(BadRequestException);

      prisma.fieldReport.findFirst.mockResolvedValue({
        id: 'rep-1',
        reportNumber: 'FR-2026-0001',
        employeeId: 'emp-author',
        createdByUserId: 'user-author',
        entityId: 'ent-1',
        status: FieldReportStatus.CHANGES_REQUESTED,
        currentRevisionId: 'rev-2',
        currentRevisionNumber: 2,
        legalHold: false,
        revisions: [],
        reviews: [],
        comments: [],
        employee: { id: 'emp-author', managerId: 'emp-mgr' },
        currentRevision: {
          id: 'rev-1',
          revisionNumber: 1,
          title: 'Safety check',
          notes: 'v1',
          occurredAt: new Date(),
          siteId: 'site-1',
          gpsConsentGranted: false,
          attachmentLinks: [
            { attachmentId: 'att-clean', caption: null, sortOrder: 0, addedInRevisionNumber: 1, attachment: { deletedAt: null, scanStatus: FieldMediaScanStatus.CLEAN } },
            { attachmentId: 'att-inf', caption: null, sortOrder: 1, addedInRevisionNumber: 1, attachment: { deletedAt: null, scanStatus: FieldMediaScanStatus.INFECTED } },
          ],
        },
      });

      await svc.reviewRevision(
        'rep-1',
        'rev-1',
        { decision: FieldReportReviewDecision.REQUEST_CHANGES, reason: 'Please add closeup photo of valve.' },
        managerViewer,
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ template: 'field-report-changes-requested' }),
      );

      await svc.createNewRevision('rep-1', authorViewer);
      expect(prisma.fieldReportRevisionAttachment.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ attachmentId: 'att-clean' })],
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.CREATE, entityType: 'FIELD_REPORT_REVISION' }),
        expect.anything(),
      );
    });

    it('handles policies, delegations, comments, team queue filters, and softDelete legalHold checks', async () => {
      const { svc, prisma } = buildServiceHarness();
      await expect(svc.findTeam({}, { userId: 'u-aud', roles: [SystemRole.AUDITOR], permissions: [] })).rejects.toThrow(
        ForbiddenException,
      );
      const mine = await svc.findMine({ page: 1, limit: 10 }, authorViewer);
      expect(mine.data.items).toEqual([]);
      const team = await svc.findTeam({ search: 'valve', unassignedManagerOnly: false }, managerViewer);
      expect(team.data.items).toEqual([]);

      prisma.fieldReport.findFirst.mockResolvedValue({
        id: 'rep-1',
        reportNumber: 'FR-2026-0001',
        employeeId: 'emp-author',
        entityId: 'ent-1',
        currentRevisionId: 'rev-1',
        legalHold: true,
        status: FieldReportStatus.DRAFT,
        createdByUserId: 'user-author',
      });
      await svc.addComment('rep-1', { body: 'Adding context' }, authorViewer);
      await expect(svc.softDelete('rep-1', authorViewer)).rejects.toThrow(/legal hold/i);

      expect(await svc.listSites()).toHaveLength(1);
      await svc.upsertPolicy(
        {
          entityId: 'ent-1',
          roleName: SystemRole.MANAGER,
          defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
          allowOriginalDownload: true,
        },
        { ...managerViewer, roles: [SystemRole.HR_ADMIN] },
      );

      await svc.createDelegation(
        {
          delegateEmployeeId: 'emp-other',
          startsAt: '2026-11-11T00:00:00Z',
          endsAt: '2026-11-18T00:00:00Z',
          reason: 'Annual leave coverage',
        },
        managerViewer,
      );
      await expect(
        svc.createDelegation(
          {
            delegateEmployeeId: 'emp-mgr',
            startsAt: '2026-11-11T00:00:00Z',
            endsAt: '2026-11-18T00:00:00Z',
          },
          managerViewer,
        ),
      ).rejects.toThrow(BadRequestException);

      prisma.fieldReportDelegation.findUnique.mockResolvedValue({
        id: 'del-1',
        delegatorEmployeeId: 'emp-mgr',
      });
      await svc.revokeDelegation('del-1', managerViewer);
    });
  });

  describe('UploadSessionService edge cases', () => {
    function buildUploadHarness() {
      const vault = new InMemoryVaultDouble();
      const cipher = createTestCipher();
      const prisma: any = {
        fieldReportRevision: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'rev-1',
            reportId: 'rep-1',
            revisionNumber: 1,
            status: FieldReportStatus.DRAFT,
            lockedAt: null,
            report: { id: 'rep-1', employeeId: 'emp-1', createdByUserId: 'u-1', status: FieldReportStatus.DRAFT },
          }),
          findUnique: jest.fn().mockResolvedValue({
            id: 'rev-1',
            revisionNumber: 1,
            status: FieldReportStatus.DRAFT,
            lockedAt: null,
          }),
        },
        fieldReportAttachment: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
        fieldReportUploadSession: {
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn(),
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        fieldReportRevisionAttachment: {
          findMany: jest.fn().mockResolvedValue([]),
          findUnique: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
          delete: jest.fn(),
          create: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
      };
      const config: any = {
        get: jest.fn((k: string, d?: any) => {
          const m: Record<string, any> = {
            'fieldReports.maxFileSizeBytes': 1024 * 1024,
            'fieldReports.maxFilesPerRevision': 2,
            'fieldReports.maxTotalBytesPerRevision': 1500 * 1024,
            'fieldReports.chunkSizeBytes': 512 * 1024,
            'fieldReports.allowedMimeTypes': [
              'image/jpeg',
              'image/heic',
              'application/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'text/plain',
            ],
          };
          return k in m ? m[k] : d;
        }),
      };
      const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
      const queue: any = { enqueueFieldMediaScan: jest.fn().mockResolvedValue(undefined) };
      const svc = new UploadSessionService(prisma, config, audit, queue, { vault, cipher } as any);
      return { svc, prisma, vault, cipher };
    }

    const viewer = {
      userId: 'u-1',
      email: 'u1@ems.local',
      employeeId: 'emp-1',
      roles: [SystemRole.EMPLOYEE],
      permissions: ['FIELD_REPORT:CREATE'],
    };

    it('rejects oversized files, disallowed mimes, quota overflow, bad chunk checksum, missing chunks, macro OOXML & spoofed content', async () => {
      const { svc, prisma, cipher, vault } = buildUploadHarness();

      await expect(
        svc.createSession(
          'rep-1',
          'rev-1',
          { originalFileName: 'big.jpg', claimedMimeType: 'image/jpeg', declaredSizeBytes: 5_000_000 },
          viewer,
        ),
      ).rejects.toThrow(PayloadTooLargeException);

      await expect(
        svc.createSession(
          'rep-1',
          'rev-1',
          { originalFileName: 'bad.exe', claimedMimeType: 'application/x-msdownload', declaredSizeBytes: 500 },
          viewer,
        ),
      ).rejects.toThrow(UnsupportedMediaTypeException);

      // Idempotent retry returns alreadyCompleted attachment
      prisma.fieldReportAttachment.findFirst.mockResolvedValueOnce({ id: 'att-existing' });
      const idem = await svc.createSession(
        'rep-1',
        'rev-1',
        {
          originalFileName: 'ok.jpg',
          claimedMimeType: 'image/jpeg',
          declaredSizeBytes: 500,
          clientCaptureId: '11111111-1111-4111-8111-111111111111',
        },
        viewer,
      );
      expect(idem.alreadyCompleted).toBe(true);

      // Quota exceeded by count
      prisma.fieldReportRevisionAttachment.findMany.mockResolvedValueOnce([
        { attachment: { fileSizeBytes: 100 } },
        { attachment: { fileSizeBytes: 100 } },
      ]);
      await expect(
        svc.createSession(
          'rep-1',
          'rev-1',
          { originalFileName: '3rd.jpg', claimedMimeType: 'image/jpeg', declaredSizeBytes: 100 },
          viewer,
        ),
      ).rejects.toThrow(PayloadTooLargeException);

      // Chunk SHA-256 mismatch
      const { wrapped, stagingKey } = cipher.createWrappedStagingKey();
      prisma.fieldReportUploadSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        reportId: 'rep-1',
        revisionId: 'rev-1',
        uploadedByUserId: 'u-1',
        employeeId: 'emp-1',
        originalFileName: 'doc.docx',
        claimedMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        declaredSizeBytes: 100,
        chunkSizeBytes: 512 * 1024,
        totalChunks: 1,
        uploadedChunks: [],
        stagingKeyPrefix: 'field-reports/staging/sessions/sess-1',
        stagingKeyEnc: wrapped,
        status: UploadSessionStatus.OPEN,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        svc.uploadChunk('sess-1', 0, Buffer.alloc(100, 0x41), viewer, '0'.repeat(64)),
      ).rejects.toThrow(ConflictException);

      // Complete session with missing chunk -> 422 INCOMPLETE_UPLOAD
      await expect(svc.completeSession('sess-1', viewer)).rejects.toMatchObject({
        status: 422,
        response: expect.objectContaining({ error: 'INCOMPLETE_UPLOAD' }),
      });

      // Macro-smuggled OOXML payload rejected with MACRO_ENABLED_OFFICE_FORBIDDEN
      const zipWithMacro = Buffer.concat([
        Buffer.from('504b0304', 'hex'),
        Buffer.from('word/vbaProject.bin'.padEnd(96, 'X')),
      ]);
      const encPart = cipher.encryptStagingPart(zipWithMacro, stagingKey, 'sess-1', 0);
      await vault.putBuffer('field-reports/staging/sessions/sess-1/part-00000', encPart);
      prisma.fieldReportUploadSession.findUnique.mockResolvedValue({
        id: 'sess-1',
        reportId: 'rep-1',
        revisionId: 'rev-1',
        uploadedByUserId: 'u-1',
        employeeId: 'emp-1',
        originalFileName: 'macro.docx',
        claimedMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        declaredSizeBytes: zipWithMacro.length,
        declaredSha256: createHash('sha256').update(zipWithMacro).digest('hex'),
        chunkSizeBytes: 512 * 1024,
        totalChunks: 1,
        uploadedChunks: [0],
        stagingKeyPrefix: 'field-reports/staging/sessions/sess-1',
        stagingKeyEnc: wrapped,
        status: UploadSessionStatus.OPEN,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(svc.completeSession('sess-1', viewer)).rejects.toMatchObject({
        status: 415,
        response: expect.objectContaining({ error: 'MACRO_ENABLED_OFFICE_FORBIDDEN' }),
      });

      // Detach attachment cleans orphan soft-delete
      prisma.fieldReportRevisionAttachment.findUnique.mockResolvedValue({
        revisionId: 'rev-1',
        attachmentId: 'att-1',
        attachment: { id: 'att-1' },
      });
      await expect(
        svc.removeAttachmentFromRevision('rep-1', 'rev-1', 'att-1', viewer),
      ).resolves.toEqual({ removed: true, attachmentId: 'att-1' });
    });
  });

  describe('FieldReportsController wiring', () => {
    it('delegates all controller routes cleanly', async () => {
      const mockSvc: any = {
        create: jest.fn().mockResolvedValue({ id: 'r1' }),
        findMine: jest.fn().mockResolvedValue({ data: [] }),
        findTeam: jest.fn().mockResolvedValue({ data: [] }),
        listSites: jest.fn().mockResolvedValue([]),
        listPolicies: jest.fn().mockResolvedValue({}),
        upsertPolicy: jest.fn().mockResolvedValue({}),
        listDelegations: jest.fn().mockResolvedValue([]),
        createDelegation: jest.fn().mockResolvedValue({}),
        revokeDelegation: jest.fn().mockResolvedValue({}),
        createNewRevision: jest.fn().mockResolvedValue({}),
        updateRevision: jest.fn().mockResolvedValue({}),
        submitRevision: jest.fn().mockResolvedValue({}),
        reviewRevision: jest.fn().mockResolvedValue({}),
        addComment: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue({ id: 'r1' }),
        softDelete: jest.fn().mockResolvedValue({ deleted: true }),
      };
      const mockUpload: any = {
        readRawChunkBody: jest.fn().mockResolvedValue(Buffer.from('abc')),
        uploadChunk: jest.fn().mockResolvedValue({ chunkIndex: 0 }),
        completeSession: jest.fn().mockResolvedValue({ attachmentId: 'a1' }),
        abortSession: jest.fn().mockResolvedValue({ status: 'ABORTED' }),
        createSession: jest.fn().mockResolvedValue({ sessionId: 's1' }),
        removeAttachmentFromRevision: jest.fn().mockResolvedValue({ removed: true }),
      };
      const mockDl: any = {
        redeemZipDownload: jest.fn().mockResolvedValue(undefined),
        redeemSingleDownload: jest.fn().mockResolvedValue(undefined),
        mintSingleGrant: jest.fn().mockResolvedValue({ grantToken: 't' }),
        mintZipGrant: jest.fn().mockResolvedValue({ grantToken: 'tz' }),
      };
      const mockCfg: any = { get: jest.fn().mockReturnValue(5_242_880) };

      const ctrl = new FieldReportsController(mockSvc, mockUpload, mockDl, mockCfg);
      const user: any = { sub: 'u1', email: 'e@x.com', employeeId: 'e1', roles: ['EMPLOYEE'], permissions: [] };
      const req: any = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, downloadGrant: { scope: 'single' } };
      const res: any = {};

      await ctrl.create({} as any, user, req);
      await ctrl.findMine({}, user);
      await ctrl.findTeam({}, user);
      await ctrl.listSites();
      await ctrl.listPolicies(user);
      await ctrl.upsertPolicy({} as any, user, req);
      await ctrl.listDelegations(user);
      await ctrl.createDelegation({} as any, user, req);
      await ctrl.revokeDelegation('d1', user, req);
      await ctrl.downloadZip(req, res);
      await ctrl.downloadSingle('bytes=0-1', req, res);
      await ctrl.uploadChunk('s1', 0, 'sha', req, user);
      await ctrl.completeUploadSession('s1', user, req);
      await ctrl.abortUploadSession('s1', user);
      await ctrl.createNewRevision('r1', user, req);
      await ctrl.updateRevision('r1', 'rev1', {} as any, user, req);
      await ctrl.submitRevision('r1', 'rev1', user, req);
      await ctrl.reviewRevision('r1', 'rev1', {} as any, user, req);
      await ctrl.createUploadSession('r1', 'rev1', {} as any, user);
      await ctrl.removeAttachment('r1', 'rev1', 'a1', user, req);
      await ctrl.addComment('r1', { body: 'hi' }, user, req);
      await ctrl.mintDownloadGrant('r1', 'a1', { variant: 'ORIGINAL' }, user);
      await ctrl.mintZipDownloadGrant('r1', { variant: FieldReportDownloadVariant.RESIZED }, user);
      await ctrl.findOne('r1', user);
      await ctrl.remove('r1', user, req);

      expect(mockSvc.create).toHaveBeenCalledTimes(1);
      expect(mockDl.redeemZipDownload).toHaveBeenCalledTimes(1);
      expect(mockUpload.uploadChunk).toHaveBeenCalledTimes(1);
    });
  });
});
