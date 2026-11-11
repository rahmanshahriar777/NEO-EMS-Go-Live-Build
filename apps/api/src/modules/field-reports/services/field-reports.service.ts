import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  FieldMediaScanStatus,
  FieldReportCategory,
  FieldReportDownloadVariant,
  FieldReportReviewDecision,
  FieldReportStatus,
  GPS_CONSENT_POLICY_VERSION,
  LeaveStatus,
  SystemRole,
  createPaginatedResponse,
  nextFieldReportNumber,
} from '@ems/shared';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { AuditService } from '../../../core/audit/audit.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  CreateDelegationDto,
  CreateFieldReportCommentDto,
  CreateFieldReportDto,
  FieldReportQueryDto,
  ReviewFieldReportDto,
  UpdateFieldReportDto,
  UpdateFieldReportPolicyDto,
} from '../dto/field-report.dto';
import { FieldReportAccessService, FieldReportViewer } from './field-report-access.service';
import { FieldReportPolicyService } from './field-report-policy.service';

@Injectable()
export class FieldReportsService {
  private readonly logger = new Logger(FieldReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
    private readonly accessService: FieldReportAccessService,
    private readonly policyService: FieldReportPolicyService,
  ) {}

  private serializeAttachment(att: any, linkMeta?: { sortOrder: number; caption: string | null; addedInRevisionNumber: number }) {
    return {
      id: att.id,
      reportId: att.reportId,
      mediaKind: att.mediaKind,
      originalFileName: att.originalFileName,
      mimeType: att.mimeType,
      fileSizeBytes: att.fileSizeBytes,
      checksumSha256: att.checksumSha256,
      widthPx: att.widthPx ?? null,
      heightPx: att.heightPx ?? null,
      exifOrientation: att.exifOrientation ?? null,
      hasEmbeddedGps: att.hasEmbeddedGps ?? null,
      scanStatus: att.scanStatus,
      scanThreats: att.scanThreats ?? [],
      scannedAt: att.scannedAt ?? null,
      processingStatus: att.processingStatus,
      processingErrorCode: att.processingErrorCode ?? null,
      processingErrorMessage: att.processingErrorMessage ?? null,
      processedAt: att.processedAt ?? null,
      createdAt: att.createdAt,
      ...(linkMeta ? linkMeta : {}),
      derivatives: Array.isArray(att.derivatives)
        ? att.derivatives.map((d: any) => ({
            id: d.id,
            kind: d.kind,
            mimeType: d.mimeType,
            fileSizeBytes: d.fileSizeBytes,
            widthPx: d.widthPx,
            heightPx: d.heightPx,
            metadataStripped: d.metadataStripped,
            colorspace: d.colorspace,
            createdAt: d.createdAt,
          }))
        : [],
    };
  }

  private serializeRevision(rev: any) {
    if (!rev) return null;
    const attachments = Array.isArray(rev.attachmentLinks)
      ? rev.attachmentLinks
          .filter((l: any) => l.attachment && !l.attachment.deletedAt)
          .sort((a: any, b: any) => a.sortOrder - b.sortOrder)
          .map((l: any) =>
            this.serializeAttachment(l.attachment, {
              sortOrder: l.sortOrder,
              caption: l.caption ?? null,
              addedInRevisionNumber: l.addedInRevisionNumber,
            }),
          )
      : [];

    return {
      id: rev.id,
      reportId: rev.reportId,
      revisionNumber: rev.revisionNumber,
      status: rev.status,
      title: rev.title,
      notes: rev.notes ?? null,
      occurredAt: rev.occurredAt,
      siteId: rev.siteId ?? null,
      site: rev.site ?? null,
      gpsConsentGranted: rev.gpsConsentGranted,
      gpsConsentAt: rev.gpsConsentAt ?? null,
      gpsConsentPolicyVersion: rev.gpsConsentPolicyVersion ?? null,
      gpsLatitude:
        rev.gpsLatitude !== null && rev.gpsLatitude !== undefined
          ? Number(rev.gpsLatitude)
          : null,
      gpsLongitude:
        rev.gpsLongitude !== null && rev.gpsLongitude !== undefined
          ? Number(rev.gpsLongitude)
          : null,
      gpsAccuracyMeters: rev.gpsAccuracyMeters ?? null,
      gpsCapturedAt: rev.gpsCapturedAt ?? null,
      submittedAt: rev.submittedAt ?? null,
      submittedByUserId: rev.submittedByUserId ?? null,
      submittedManagerSnapshotId: rev.submittedManagerSnapshotId ?? null,
      lockedAt: rev.lockedAt ?? null,
      reviewedAt: rev.reviewedAt ?? null,
      reviewedByUserId: rev.reviewedByUserId ?? null,
      reviewDecisionNote: rev.reviewDecisionNote ?? null,
      createdAt: rev.createdAt,
      updatedAt: rev.updatedAt,
      attachments,
    };
  }

  private serializeListItem(report: any) {
    const rev = report.currentRevision;
    const activeAttachments = Array.isArray(rev?.attachmentLinks)
      ? rev.attachmentLinks.filter((l: any) => l.attachment && !l.attachment.deletedAt)
      : [];

    return {
      id: report.id,
      reportNumber: report.reportNumber,
      employeeId: report.employeeId,
      entityId: report.entityId ?? null,
      siteId: report.siteId ?? null,
      site: report.site ?? rev?.site ?? null,
      category: report.category,
      status: report.status,
      currentRevisionNumber: report.currentRevisionNumber,
      currentRevisionId: report.currentRevisionId ?? null,
      latestSubmittedAt: report.latestSubmittedAt ?? null,
      legalHold: report.legalHold,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      employee: report.employee
        ? {
            id: report.employee.id,
            employeeNumber: report.employee.employeeNumber,
            firstName: report.employee.firstName,
            lastName: report.employee.lastName,
            managerId: report.employee.managerId ?? null,
          }
        : undefined,
      unassignedManager: report.employee ? report.employee.managerId == null : false,
      currentRevision: rev
        ? {
            id: rev.id,
            revisionNumber: rev.revisionNumber,
            status: rev.status,
            title: rev.title,
            notes: rev.notes ?? null,
            occurredAt: rev.occurredAt,
            gpsConsentGranted: rev.gpsConsentGranted,
            lockedAt: rev.lockedAt ?? null,
            submittedAt: rev.submittedAt ?? null,
            reviewedAt: rev.reviewedAt ?? null,
            reviewDecisionNote: rev.reviewDecisionNote ?? null,
            attachmentCount: activeAttachments.length,
          }
        : null,
    };
  }

  private async resolveAuthorEmployee(viewer: FieldReportViewer) {
    const emp = await this.prisma.employee.findFirst({
      where: viewer.employeeId
        ? { id: viewer.employeeId, deletedAt: null }
        : { userId: viewer.userId, deletedAt: null },
      select: { id: true, userId: true, entityId: true, managerId: true },
    });
    if (!emp) {
      throw new ForbiddenException({
        message: 'An active employee profile is required to create or modify field reports.',
        error: 'FORBIDDEN',
      });
    }
    return emp;
  }

  private validateGpsPayload(dto: {
    gpsConsentGranted?: boolean;
    gpsLatitude?: number;
    gpsLongitude?: number;
    gpsAccuracyMeters?: number;
    gpsCapturedAt?: string;
  }) {
    const hasCoords =
      (dto.gpsLatitude !== undefined && dto.gpsLatitude !== null) ||
      (dto.gpsLongitude !== undefined && dto.gpsLongitude !== null) ||
      (dto.gpsAccuracyMeters !== undefined && dto.gpsAccuracyMeters !== null) ||
      Boolean(dto.gpsCapturedAt);

    if (hasCoords && dto.gpsConsentGranted !== true) {
      throw new BadRequestException({
        message: 'GPS coordinates cannot be stored unless gpsConsentGranted is true.',
        error: 'INVALID_MEDIA_CONTENT',
      });
    }

    if (
      (dto.gpsLatitude !== undefined && dto.gpsLongitude === undefined) ||
      (dto.gpsLatitude === undefined && dto.gpsLongitude !== undefined)
    ) {
      throw new BadRequestException({
        message: 'Both gpsLatitude and gpsLongitude must be provided together.',
        error: 'INVALID_MEDIA_CONTENT',
      });
    }
  }

  private buildListFilters(query: FieldReportQueryDto) {
    const andClauses: any[] = [];
    if (query.status) {
      andClauses.push({ status: query.status });
    }
    if (query.category) {
      andClauses.push({ category: query.category });
    }
    if (query.siteId) {
      andClauses.push({ siteId: query.siteId });
    }
    if (query.dateFrom || query.dateTo) {
      const occurredRange: Record<string, Date> = {};
      if (query.dateFrom) occurredRange.gte = new Date(query.dateFrom);
      if (query.dateTo) occurredRange.lte = new Date(query.dateTo);
      andClauses.push({ currentRevision: { occurredAt: occurredRange } });
    }
    if (query.search && query.search.trim().length > 0) {
      const term = query.search.trim();
      andClauses.push({
        OR: [
          { reportNumber: { contains: term, mode: 'insensitive' } },
          { currentRevision: { title: { contains: term, mode: 'insensitive' } } },
          { currentRevision: { notes: { contains: term, mode: 'insensitive' } } },
        ],
      });
    }
    return andClauses;
  }

  async create(dto: CreateFieldReportDto, viewer: FieldReportViewer, ipAddress?: string) {
    const author = await this.resolveAuthorEmployee(viewer);
    this.validateGpsPayload(dto);

    if (dto.siteId) {
      const site = await this.prisma.site.findUnique({ where: { id: dto.siteId } });
      if (!site) {
        throw new BadRequestException({
          message: `Unknown siteId '${dto.siteId}'.`,
          error: 'INVALID_MEDIA_CONTENT',
        });
      }
    }

    const reportNumber = await nextFieldReportNumber((sql) =>
      this.prisma.$queryRawUnsafe(sql),
    );
    const now = new Date();
    const consentGranted = dto.gpsConsentGranted === true || (dto as any).gpsConsent === true;
    const rawOccurred = dto.occurredAt || (dto as any).incidentAt;
    let occurredDate = now;
    if (rawOccurred) {
      const parsed = new Date(rawOccurred);
      if (!isNaN(parsed.getTime())) {
        occurredDate = parsed;
      }
    }
    const lat = consentGranted ? ((dto as any).latitude ?? dto.gpsLatitude ?? null) : null;
    const lon = consentGranted ? ((dto as any).longitude ?? dto.gpsLongitude ?? null) : null;
    const acc = consentGranted ? ((dto as any).accuracyMeters ?? dto.gpsAccuracyMeters ?? null) : null;

    const createdId = await this.prisma.$transaction(async (tx) => {
      const report = await tx.fieldReport.create({
        data: {
          reportNumber,
          employeeId: author.id,
          createdByUserId: viewer.userId,
          entityId: author.entityId ?? null,
          siteId: dto.siteId ?? null,
          category: dto.category,
          status: FieldReportStatus.DRAFT,
          currentRevisionNumber: 1,
        },
      });

      const revision = await tx.fieldReportRevision.create({
        data: {
          reportId: report.id,
          revisionNumber: 1,
          status: FieldReportStatus.DRAFT,
          title: dto.title.trim(),
          notes: dto.notes?.trim() ?? null,
          occurredAt: occurredDate,
          siteId: dto.siteId ?? null,
          gpsConsentGranted: consentGranted,
          gpsConsentAt: consentGranted ? now : null,
          gpsConsentPolicyVersion: consentGranted
            ? dto.gpsConsentPolicyVersion || GPS_CONSENT_POLICY_VERSION
            : null,
          gpsLatitude: lat !== null && lat !== undefined ? lat : null,
          gpsLongitude: lon !== null && lon !== undefined ? lon : null,
          gpsAccuracyMeters: acc !== null && acc !== undefined ? acc : null,
          gpsCapturedAt:
            consentGranted && (dto.gpsCapturedAt || rawOccurred)
              ? (() => {
                  const d = new Date(dto.gpsCapturedAt || rawOccurred);
                  return isNaN(d.getTime()) ? now : d;
                })()
              : null,
        },
      });

      await tx.fieldReport.update({
        where: { id: report.id },
        data: { currentRevisionId: revision.id },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.CREATE,
          entityType: 'FIELD_REPORT',
          entityId: report.id,
          afterState: {
            reportNumber,
            category: dto.category,
            siteId: dto.siteId ?? null,
            gpsConsentGranted: consentGranted,
            hasGpsCoordinates:
              consentGranted && dto.gpsLatitude !== undefined && dto.gpsLongitude !== undefined,
          },
          ipAddress,
        },
        tx as any,
      );

      return report.id;
    });

    return this.findOne(createdId, viewer);
  }

  async findMine(query: FieldReportQueryDto, viewer: FieldReportViewer) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const empId =
      viewer.employeeId ??
      (
        await this.prisma.employee.findFirst({
          where: { userId: viewer.userId, deletedAt: null },
          select: { id: true },
        })
      )?.id;

    if (!empId) {
      return createPaginatedResponse([], 0, page, limit);
    }

    const andClauses = this.buildListFilters(query);
    const where: any = {
      employeeId: empId,
      deletedAt: null,
      ...(andClauses.length > 0 ? { AND: andClauses } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.fieldReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          site: { select: { id: true, name: true, location: true } },
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              firstName: true,
              lastName: true,
              managerId: true,
            },
          },
          currentRevision: {
            include: {
              site: { select: { id: true, name: true, location: true } },
              attachmentLinks: {
                include: { attachment: { select: { id: true, deletedAt: true } } },
              },
            },
          },
        },
      }),
      this.prisma.fieldReport.count({ where }),
    ]);

    return createPaginatedResponse(
      items.map((r) => this.serializeListItem(r)),
      total,
      page,
      limit,
    );
  }

  async findTeam(query: FieldReportQueryDto, viewer: FieldReportViewer) {
    if (this.accessService.isExplicitlyAuditorOnly(viewer.roles)) {
      throw new ForbiddenException({
        message: 'Auditors cannot access employee field reports.',
        error: 'FORBIDDEN',
      });
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const isHr = this.accessService.isHrOrAdmin(viewer.roles);
    const andClauses = this.buildListFilters(query);

    // Team queue excludes private DRAFTs unless HR explicitly asks for DRAFT.
    if (!query.status) {
      andClauses.push({ status: { not: FieldReportStatus.DRAFT } });
    } else if (!isHr && query.status === FieldReportStatus.DRAFT) {
      return createPaginatedResponse([], 0, page, limit);
    }

    if (isHr) {
      if (query.employeeId) {
        andClauses.push({ employeeId: query.employeeId });
      }
      if (query.unassignedManagerOnly) {
        andClauses.push({ employee: { managerId: null } });
      }
    } else {
      const delegatorLinks = await this.accessService.getActiveDelegatorIds(viewer.employeeId);
      const scopeOr: any[] = [];

      if (viewer.employeeId && viewer.roles.includes(SystemRole.MANAGER)) {
        scopeOr.push({ employee: { managerId: viewer.employeeId } });
      }
      for (const link of delegatorLinks) {
        if (link.entityId) {
          scopeOr.push({
            employee: { managerId: link.delegatorEmployeeId },
            entityId: link.entityId,
          });
        } else {
          scopeOr.push({ employee: { managerId: link.delegatorEmployeeId } });
        }
      }

      if (scopeOr.length === 0) {
        return createPaginatedResponse([], 0, page, limit);
      }

      andClauses.push({ OR: scopeOr });
      if (viewer.employeeId) {
        andClauses.push({ employeeId: { not: viewer.employeeId } });
      }
      if (query.employeeId) {
        andClauses.push({ employeeId: query.employeeId });
      }
    }

    const where: any = {
      deletedAt: null,
      AND: andClauses,
    };

    const [items, total] = await Promise.all([
      this.prisma.fieldReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ latestSubmittedAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          site: { select: { id: true, name: true, location: true } },
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              firstName: true,
              lastName: true,
              managerId: true,
            },
          },
          currentRevision: {
            include: {
              site: { select: { id: true, name: true, location: true } },
              attachmentLinks: {
                include: { attachment: { select: { id: true, deletedAt: true } } },
              },
            },
          },
        },
      }),
      this.prisma.fieldReport.count({ where }),
    ]);

    return createPaginatedResponse(
      items.map((r) => this.serializeListItem(r)),
      total,
      page,
      limit,
    );
  }

  async findOne(id: string, viewer: FieldReportViewer) {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id, deletedAt: null },
      include: {
        site: { select: { id: true, name: true, location: true, timezone: true } },
        employee: {
          select: {
            id: true,
            employeeNumber: true,
            firstName: true,
            lastName: true,
            email: true,
            managerId: true,
            department: { select: { id: true, name: true } },
            manager: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true },
            },
          },
        },
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          include: {
            site: { select: { id: true, name: true, location: true } },
            attachmentLinks: {
              orderBy: { sortOrder: 'asc' },
              include: {
                attachment: {
                  include: {
                    derivatives: { orderBy: { kind: 'asc' } },
                  },
                },
              },
            },
          },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          include: {
            reviewerEmployee: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true },
            },
            actedAsDelegateFor: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true },
            },
          },
        },
        comments: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          include: {
            authorEmployee: {
              select: { id: true, firstName: true, lastName: true, employeeNumber: true },
            },
          },
        },
      },
    });

    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    await this.accessService.assertCanRead(viewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const [effectivePolicy, reviewAuth] = await Promise.all([
      this.policyService.resolveEffectivePolicy(viewer, report.entityId),
      this.accessService.canReview(viewer, {
        employeeId: report.employeeId,
        entityId: report.entityId,
      }),
    ]);

    // Check if the direct manager has an approved overlapping leave today -> delegate hint for UI.
    let managerOnLeaveToday = false;
    if (report.employee?.managerId) {
      const now = new Date();
      const leaveOverlap = await this.prisma.leaveRequest.findFirst({
        where: {
          employeeId: report.employee.managerId,
          status: LeaveStatus.APPROVED,
          startDate: { lte: now },
          endDate: { gte: now },
        },
        select: { id: true },
      });
      managerOnLeaveToday = Boolean(leaveOverlap);
    }

    const serializedRevisions = report.revisions.map((r) => this.serializeRevision(r));
    const currentRevision =
      serializedRevisions.find((r) => r?.id === report.currentRevisionId) ??
      serializedRevisions[0] ??
      null;

    return {
      id: report.id,
      reportNumber: report.reportNumber,
      employeeId: report.employeeId,
      createdByUserId: report.createdByUserId,
      entityId: report.entityId,
      siteId: report.siteId,
      site: report.site,
      category: report.category,
      status: report.status,
      currentRevisionNumber: report.currentRevisionNumber,
      currentRevisionId: report.currentRevisionId,
      latestSubmittedAt: report.latestSubmittedAt,
      legalHold: report.legalHold,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      unassignedManager: report.employee?.managerId == null,
      managerOnLeaveToday,
      employee: report.employee,
      currentRevision,
      revisions: serializedRevisions,
      reviews: report.reviews,
      comments: report.comments,
      effectivePolicy,
      canReview:
        reviewAuth.allowed &&
        report.status === FieldReportStatus.SUBMITTED &&
        (viewer.permissions.includes('FIELD_REPORT:REVIEW') ||
          viewer.roles.includes(SystemRole.SUPER_ADMIN)),
      reviewContext: {
        actedAsDelegateForId: reviewAuth.actedAsDelegateForId,
      },
    };
  }

  async updateRevision(
    reportId: string,
    revisionId: string,
    dto: UpdateFieldReportDto,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisionId);
    const revision = await this.prisma.fieldReportRevision.findFirst({
      where: isUuid
        ? { id: revisionId, reportId, report: { deletedAt: null } }
        : { revisionNumber: parseInt(revisionId, 10) || 1, reportId, report: { deletedAt: null } },
      include: { report: true },
    });
    if (!revision) {
      throw new NotFoundException({
        message: 'Field report revision not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const isOwner =
      revision.report.createdByUserId === viewer.userId ||
      (viewer.employeeId && revision.report.employeeId === viewer.employeeId);
    if (!isOwner) {
      throw new ForbiddenException({
        message: 'Only the report author can edit draft revisions.',
        error: 'FORBIDDEN',
      });
    }

    if (revision.status !== FieldReportStatus.DRAFT || revision.lockedAt !== null) {
      throw new ConflictException({
        message: 'Submitted revisions are immutable. Fork a new revision when changes are requested.',
        error: 'REVISION_IMMUTABLE',
      });
    }

    const effectiveConsent =
      dto.gpsConsentGranted !== undefined
        ? dto.gpsConsentGranted
        : revision.gpsConsentGranted;

    const nextLat =
      dto.gpsConsentGranted === false
        ? null
        : dto.gpsLatitude !== undefined
          ? dto.gpsLatitude
          : revision.gpsLatitude !== null
            ? Number(revision.gpsLatitude)
            : undefined;
    const nextLng =
      dto.gpsConsentGranted === false
        ? null
        : dto.gpsLongitude !== undefined
          ? dto.gpsLongitude
          : revision.gpsLongitude !== null
            ? Number(revision.gpsLongitude)
            : undefined;

    if (
      dto.gpsConsentGranted !== false &&
      (dto.gpsLatitude !== undefined ||
        dto.gpsLongitude !== undefined ||
        dto.gpsAccuracyMeters !== undefined ||
        dto.gpsCapturedAt !== undefined)
    ) {
      this.validateGpsPayload({
        gpsConsentGranted: effectiveConsent,
        gpsLatitude: nextLat ?? undefined,
        gpsLongitude: nextLng ?? undefined,
        gpsAccuracyMeters: dto.gpsAccuracyMeters,
        gpsCapturedAt: dto.gpsCapturedAt,
      });
    }

    if (dto.siteId) {
      const site = await this.prisma.site.findUnique({ where: { id: dto.siteId } });
      if (!site) {
        throw new BadRequestException({
          message: `Unknown siteId '${dto.siteId}'.`,
          error: 'INVALID_MEDIA_CONTENT',
        });
      }
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const revUpdateData: any = {};
      if (dto.title !== undefined) revUpdateData.title = dto.title.trim();
      if (dto.notes !== undefined) revUpdateData.notes = dto.notes?.trim() ?? null;
      if (dto.occurredAt !== undefined) revUpdateData.occurredAt = new Date(dto.occurredAt);
      if (dto.siteId !== undefined) revUpdateData.siteId = dto.siteId || null;

      if (dto.gpsConsentGranted === false) {
        revUpdateData.gpsConsentGranted = false;
        revUpdateData.gpsConsentAt = null;
        revUpdateData.gpsConsentPolicyVersion = null;
        revUpdateData.gpsLatitude = null;
        revUpdateData.gpsLongitude = null;
        revUpdateData.gpsAccuracyMeters = null;
        revUpdateData.gpsCapturedAt = null;
      } else {
        if (dto.gpsConsentGranted === true) {
          revUpdateData.gpsConsentGranted = true;
          revUpdateData.gpsConsentAt = revision.gpsConsentAt ?? now;
          revUpdateData.gpsConsentPolicyVersion =
            dto.gpsConsentPolicyVersion ||
            revision.gpsConsentPolicyVersion ||
            GPS_CONSENT_POLICY_VERSION;
        }
        if (dto.gpsLatitude !== undefined) revUpdateData.gpsLatitude = dto.gpsLatitude;
        if (dto.gpsLongitude !== undefined) revUpdateData.gpsLongitude = dto.gpsLongitude;
        if (dto.gpsAccuracyMeters !== undefined) {
          revUpdateData.gpsAccuracyMeters = dto.gpsAccuracyMeters;
        }
        if (dto.gpsCapturedAt !== undefined) {
          revUpdateData.gpsCapturedAt = new Date(dto.gpsCapturedAt);
        }
      }

      await tx.fieldReportRevision.update({
        where: { id: revisionId },
        data: revUpdateData,
      });

      if (dto.category !== undefined || dto.siteId !== undefined) {
        await tx.fieldReport.update({
          where: { id: reportId },
          data: {
            ...(dto.category !== undefined ? { category: dto.category } : {}),
            ...(dto.siteId !== undefined ? { siteId: dto.siteId || null } : {}),
          },
        });
      }

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.UPDATE,
          entityType: 'FIELD_REPORT_REVISION',
          entityId: revisionId,
          afterState: {
            reportId,
            revisionNumber: revision.revisionNumber,
            category: dto.category ?? revision.report.category,
            siteId: dto.siteId !== undefined ? dto.siteId : revision.siteId,
            gpsConsentGranted: effectiveConsent,
          },
          ipAddress,
        },
        tx as any,
      );
    });

    return this.findOne(reportId, viewer);
  }

  async createNewRevision(reportId: string, viewer: FieldReportViewer, ipAddress?: string) {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: reportId, deletedAt: null },
      include: {
        currentRevision: {
          include: {
            attachmentLinks: {
              orderBy: { sortOrder: 'asc' },
              include: { attachment: true },
            },
          },
        },
      },
    });
    if (!report || !report.currentRevision) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const isOwner =
      report.createdByUserId === viewer.userId ||
      (viewer.employeeId && report.employeeId === viewer.employeeId);
    if (!isOwner) {
      throw new ForbiddenException({
        message: 'Only the report author can create a new revision.',
        error: 'FORBIDDEN',
      });
    }

    if (report.status !== FieldReportStatus.CHANGES_REQUESTED) {
      throw new ConflictException({
        message: 'A new revision can only be created when the report is in CHANGES_REQUESTED state.',
        error: 'REVISION_IMMUTABLE',
      });
    }

    const prevRev = report.currentRevision;
    const nextRevNumber = report.currentRevisionNumber + 1;

    await this.prisma.$transaction(async (tx) => {
      const newRev = await tx.fieldReportRevision.create({
        data: {
          reportId: report.id,
          revisionNumber: nextRevNumber,
          status: FieldReportStatus.DRAFT,
          title: prevRev.title,
          notes: prevRev.notes,
          occurredAt: prevRev.occurredAt,
          siteId: prevRev.siteId,
          gpsConsentGranted: prevRev.gpsConsentGranted,
          gpsConsentAt: prevRev.gpsConsentAt,
          gpsConsentPolicyVersion: prevRev.gpsConsentPolicyVersion,
          gpsLatitude: prevRev.gpsLatitude,
          gpsLongitude: prevRev.gpsLongitude,
          gpsAccuracyMeters: prevRev.gpsAccuracyMeters,
          gpsCapturedAt: prevRev.gpsCapturedAt,
        },
      });

      const reusableLinks = prevRev.attachmentLinks.filter(
        (l) => !l.attachment.deletedAt && l.attachment.scanStatus !== FieldMediaScanStatus.INFECTED,
      );
      if (reusableLinks.length > 0) {
        await tx.fieldReportRevisionAttachment.createMany({
          data: reusableLinks.map((l, idx) => ({
            revisionId: newRev.id,
            attachmentId: l.attachmentId,
            sortOrder: idx,
            caption: l.caption,
            addedInRevisionNumber: l.addedInRevisionNumber,
          })),
        });
      }

      await tx.fieldReport.update({
        where: { id: report.id },
        data: {
          status: FieldReportStatus.DRAFT,
          currentRevisionNumber: nextRevNumber,
          currentRevisionId: newRev.id,
        },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.CREATE,
          entityType: 'FIELD_REPORT_REVISION',
          entityId: newRev.id,
          afterState: {
            reportId: report.id,
            revisionNumber: nextRevNumber,
            copiedAttachments: reusableLinks.length,
          },
          ipAddress,
        },
        tx as any,
      );
    });

    return this.findOne(reportId, viewer);
  }

  async submitRevision(
    reportId: string,
    revisionId: string,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisionId);
    const revision = await this.prisma.fieldReportRevision.findFirst({
      where: isUuid
        ? { id: revisionId, reportId, report: { deletedAt: null } }
        : { revisionNumber: parseInt(revisionId, 10) || 1, reportId, report: { deletedAt: null } },
      include: {
        report: true,
        attachmentLinks: {
          include: { attachment: true },
        },
      },
    });
    if (!revision) {
      throw new NotFoundException({
        message: 'Field report revision not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const isOwner =
      revision.report.createdByUserId === viewer.userId ||
      (viewer.employeeId && revision.report.employeeId === viewer.employeeId);
    if (!isOwner) {
      throw new ForbiddenException({
        message: 'Only the report author can submit this report.',
        error: 'FORBIDDEN',
      });
    }

    if (
      revision.status !== FieldReportStatus.DRAFT ||
      revision.lockedAt !== null ||
      revision.report.currentRevisionId !== revision.id
    ) {
      throw new ConflictException({
        message: 'Only the active unlocked DRAFT revision can be submitted.',
        error: 'REVISION_IMMUTABLE',
      });
    }

    const activeAttachments = revision.attachmentLinks
      .map((l) => l.attachment)
      .filter((a) => !a.deletedAt);

    const infectedIds = activeAttachments
      .filter((a) => a.scanStatus === FieldMediaScanStatus.INFECTED)
      .map((a) => a.id);
    if (infectedIds.length > 0) {
      throw new ForbiddenException({
        message: 'Remove infected attachment(s) before submitting this field report.',
        error: 'SCAN_INFECTED',
        details: { attachmentIds: infectedIds },
      });
    }

    const unscannedIds = activeAttachments
      .filter((a) => a.scanStatus !== FieldMediaScanStatus.CLEAN)
      .map((a) => a.id);
    if (unscannedIds.length > 0) {
      throw new ConflictException({
        message: 'Wait for malware scanning to finish on all attachments before submitting.',
        error: 'SCAN_PENDING',
        details: { attachmentIds: unscannedIds },
      });
    }

    const policy = await this.policyService.resolveEffectivePolicy(
      viewer,
      revision.report.entityId,
    );
    if (
      policy.requireGpsForCategories.includes(revision.report.category as FieldReportCategory) &&
      (!revision.gpsConsentGranted ||
        revision.gpsLatitude === null ||
        revision.gpsLongitude === null)
    ) {
      throw new BadRequestException({
        message: `Consented GPS coordinates are required for ${revision.report.category} reports.`,
        error: 'GPS_REQUIRED',
      });
    }

    const author = await this.prisma.employee.findFirst({
      where: { id: revision.report.employeeId, deletedAt: null },
      include: {
        manager: {
          select: {
            id: true,
            userId: true,
            email: true,
            firstName: true,
            lastName: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!author) {
      throw new NotFoundException({
        message: 'Author employee record not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const now = new Date();
    const managerSnapshotId =
      author.manager && !author.manager.deletedAt ? author.manager.id : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.fieldReportRevision.update({
        where: { id: revision.id },
        data: {
          status: FieldReportStatus.SUBMITTED,
          submittedAt: now,
          submittedByUserId: viewer.userId,
          submittedManagerSnapshotId: managerSnapshotId,
          lockedAt: now,
        },
      });

      await tx.fieldReport.update({
        where: { id: revision.reportId },
        data: {
          status: FieldReportStatus.SUBMITTED,
          latestSubmittedAt: now,
          siteId: revision.siteId,
        },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.UPDATE,
          entityType: 'FIELD_REPORT_REVISION',
          entityId: revision.id,
          afterState: {
            reportId: revision.reportId,
            reportNumber: revision.report.reportNumber,
            revisionNumber: revision.revisionNumber,
            status: FieldReportStatus.SUBMITTED,
            submittedManagerSnapshotId: managerSnapshotId,
            attachmentCount: activeAttachments.length,
            gpsConsentGranted: revision.gpsConsentGranted,
          },
          ipAddress,
        },
        tx as any,
      );
    });

    const routing = await this.dispatchSubmissionNotifications({
      reportId: revision.report.id,
      reportNumber: revision.report.reportNumber,
      revisionId: revision.id,
      revisionTitle: revision.title,
      authorName: `${author.firstName} ${author.lastName}`,
      entityId: revision.report.entityId,
      manager: author.manager && !author.manager.deletedAt ? author.manager : null,
      authorUserId: viewer.userId,
      now,
    });

    const detail = await this.findOne(reportId, viewer);
    return {
      ...detail,
      routing,
    };
  }

  private async dispatchSubmissionNotifications(input: {
    reportId: string;
    reportNumber: string;
    revisionId: string;
    revisionTitle: string;
    authorName: string;
    entityId: string | null;
    manager: { id: string; userId: string | null; email: string } | null;
    authorUserId: string;
    now: Date;
  }): Promise<'DIRECT_MANAGER' | 'HR_ESCALATION'> {
    const linkUrl = `/field-reports/${input.reportId}`;
    const recipients = new Map<string, { userId: string; email: string }>();

    if (input.manager?.userId) {
      recipients.set(input.manager.userId, {
        userId: input.manager.userId,
        email: input.manager.email,
      });

      const delegates = await this.prisma.fieldReportDelegation.findMany({
        where: {
          delegatorEmployeeId: input.manager.id,
          isActive: true,
          revokedAt: null,
          startsAt: { lte: input.now },
          endsAt: { gte: input.now },
          OR: [
            { entityId: null },
            ...(input.entityId ? [{ entityId: input.entityId }] : []),
          ],
        },
        include: {
          delegate: {
            select: { userId: true, email: true, deletedAt: true },
          },
        },
      });
      for (const del of delegates) {
        if (del.delegate?.userId && !del.delegate.deletedAt) {
          recipients.set(del.delegate.userId, {
            userId: del.delegate.userId,
            email: del.delegate.email,
          });
        }
      }
    } else {
      // Unassigned manager: route to active HR_ADMIN users (entity-scoped fallback to global HR).
      const hrUsers = await this.prisma.user.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          id: { not: input.authorUserId },
          roles: { some: { role: { name: SystemRole.HR_ADMIN } } },
        },
        select: {
          id: true,
          email: true,
          employee: { select: { entityId: true } },
        },
      });
      const scopedHr = input.entityId
        ? hrUsers.filter((u) => u.employee?.entityId === input.entityId)
        : hrUsers;
      const targets = scopedHr.length > 0 ? scopedHr : hrUsers;
      for (const u of targets) {
        recipients.set(u.id, { userId: u.id, email: u.email });
      }
    }

    for (const target of recipients.values()) {
      await this.notificationsService.notify({
        userId: target.userId,
        template: 'field-report-submitted',
        title: `Field Report ${input.reportNumber} submitted for review`,
        message: `${input.authorName} submitted "${input.revisionTitle}" for your review.`,
        linkUrl,
        idempotencyKey: `field-report-submitted:${input.revisionId}:${target.userId}`,
        emailCopy: true,
        emailTo: target.email,
        emailSubject: `[Field Report] ${input.reportNumber} submitted by ${input.authorName}`,
      });
    }

    return input.manager ? 'DIRECT_MANAGER' : 'HR_ESCALATION';
  }

  async reviewRevision(
    reportId: string,
    revisionId: string,
    dto: ReviewFieldReportDto,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revisionId);
    const revision = await this.prisma.fieldReportRevision.findFirst({
      where: isUuid
        ? { id: revisionId, reportId, report: { deletedAt: null } }
        : { revisionNumber: parseInt(revisionId, 10) || 1, reportId, report: { deletedAt: null } },
      include: {
        report: {
          include: {
            employee: { select: { id: true, userId: true, email: true, firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!revision) {
      throw new NotFoundException({
        message: 'Field report revision not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const { actedAsDelegateForId } = await this.accessService.assertCanReview(viewer, {
      employeeId: revision.report.employeeId,
      entityId: revision.report.entityId,
    });

    if (revision.status !== FieldReportStatus.SUBMITTED) {
      throw new ConflictException({
        message: 'Only SUBMITTED revisions can be reviewed.',
        error: 'REVISION_IMMUTABLE',
      });
    }

    if (
      dto.decision !== FieldReportReviewDecision.APPROVE &&
      (!dto.reason || dto.reason.trim().length < 5)
    ) {
      throw new BadRequestException({
        message: 'A review reason (at least 5 characters) is required when rejecting or requesting changes.',
        error: 'REASON_REQUIRED',
      });
    }

    const statusMap: Record<FieldReportReviewDecision, FieldReportStatus> = {
      [FieldReportReviewDecision.APPROVE]: FieldReportStatus.APPROVED,
      [FieldReportReviewDecision.REJECT]: FieldReportStatus.REJECTED,
      [FieldReportReviewDecision.REQUEST_CHANGES]: FieldReportStatus.CHANGES_REQUESTED,
    };
    const auditMap: Record<FieldReportReviewDecision, AuditAction> = {
      [FieldReportReviewDecision.APPROVE]: AuditAction.APPROVE,
      [FieldReportReviewDecision.REJECT]: AuditAction.REJECT,
      [FieldReportReviewDecision.REQUEST_CHANGES]: AuditAction.UPDATE,
    };

    const nextStatus = statusMap[dto.decision];
    const cleanReason = dto.reason?.trim() || null;
    const now = new Date();

    const review = await this.prisma.$transaction(async (tx) => {
      const createdReview = await tx.fieldReportReview.create({
        data: {
          reportId,
          revisionId,
          reviewerUserId: viewer.userId,
          reviewerEmployeeId: viewer.employeeId ?? null,
          actedAsDelegateForId,
          decision: dto.decision,
          reason: cleanReason,
        },
      });

      await tx.fieldReportRevision.update({
        where: { id: revisionId },
        data: {
          status: nextStatus,
          reviewedAt: now,
          reviewedByUserId: viewer.userId,
          reviewDecisionNote: cleanReason,
        },
      });

      await tx.fieldReport.update({
        where: { id: reportId },
        data: { status: nextStatus },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: auditMap[dto.decision],
          entityType: 'FIELD_REPORT_REVIEW',
          entityId: createdReview.id,
          afterState: {
            reportId,
            reportNumber: revision.report.reportNumber,
            revisionId,
            decision: dto.decision,
            nextStatus,
            actedAsDelegateForId,
            reason: cleanReason,
          },
          ipAddress,
        },
        tx as any,
      );

      return createdReview;
    });

    const author = revision.report.employee;
    const recipientUserId = author?.userId || revision.report.createdByUserId;
    const templateMap: Record<FieldReportReviewDecision, string> = {
      [FieldReportReviewDecision.APPROVE]: 'field-report-approved',
      [FieldReportReviewDecision.REJECT]: 'field-report-rejected',
      [FieldReportReviewDecision.REQUEST_CHANGES]: 'field-report-changes-requested',
    };
    const labelMap: Record<FieldReportReviewDecision, string> = {
      [FieldReportReviewDecision.APPROVE]: 'approved',
      [FieldReportReviewDecision.REJECT]: 'rejected',
      [FieldReportReviewDecision.REQUEST_CHANGES]: 'returned for changes',
    };

    if (recipientUserId) {
      await this.notificationsService.notify({
        userId: recipientUserId,
        template: templateMap[dto.decision],
        title: `Field Report ${revision.report.reportNumber} ${labelMap[dto.decision]}`,
        message: cleanReason
          ? `Your report "${revision.title}" was ${labelMap[dto.decision]}: ${cleanReason}`
          : `Your report "${revision.title}" was ${labelMap[dto.decision]}.`,
        linkUrl: `/field-reports/${reportId}`,
        idempotencyKey: `field-report-review:${review.id}`,
        emailCopy: Boolean(author?.email),
        emailTo: author?.email,
        emailSubject: `[Field Report] ${revision.report.reportNumber} ${labelMap[dto.decision]}`,
      });
    }

    return this.findOne(reportId, viewer);
  }

  async addComment(
    reportId: string,
    dto: CreateFieldReportCommentDto,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: reportId, deletedAt: null },
      select: { id: true, employeeId: true, entityId: true, currentRevisionId: true },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const { actedAsDelegateForId } = await this.accessService.assertCanRead(viewer, {
      employeeId: report.employeeId,
      entityId: report.entityId,
    });

    const targetRevisionId = dto.revisionId ?? report.currentRevisionId ?? null;
    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fieldReportComment.create({
        data: {
          reportId: report.id,
          revisionId: targetRevisionId,
          authorUserId: viewer.userId,
          authorEmployeeId: viewer.employeeId ?? null,
          actedAsDelegateForId,
          body: dto.body.trim(),
        },
        include: {
          authorEmployee: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
        },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.CREATE,
          entityType: 'FIELD_REPORT_COMMENT',
          entityId: created.id,
          afterState: {
            reportId: report.id,
            revisionId: targetRevisionId,
            actedAsDelegateForId,
          },
          ipAddress,
        },
        tx as any,
      );

      return created;
    });

    return comment;
  }

  async softDelete(reportId: string, viewer: FieldReportViewer, ipAddress?: string) {
    const report = await this.prisma.fieldReport.findFirst({
      where: { id: reportId, deletedAt: null },
    });
    if (!report) {
      throw new NotFoundException({
        message: 'Field report not found.',
        error: 'REPORT_NOT_FOUND',
      });
    }

    const isHr = this.accessService.isHrOrAdmin(viewer.roles);
    const isOwner =
      report.createdByUserId === viewer.userId ||
      (viewer.employeeId && report.employeeId === viewer.employeeId);

    if (!isHr && !isOwner) {
      throw new ForbiddenException({
        message: 'You are not allowed to delete this field report.',
        error: 'FORBIDDEN',
      });
    }
    if (!isHr && report.status !== FieldReportStatus.DRAFT) {
      throw new ForbiddenException({
        message: 'Only HR/Admins can delete submitted or reviewed field reports.',
        error: 'FORBIDDEN',
      });
    }
    if (report.legalHold) {
      throw new ForbiddenException({
        message: 'Reports placed under legal hold cannot be deleted.',
        error: 'FORBIDDEN',
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.fieldReport.update({
        where: { id: reportId },
        data: { deletedAt: now },
      });
      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.DELETE,
          entityType: 'FIELD_REPORT',
          entityId: reportId,
          afterState: { reportNumber: report.reportNumber, deletedAt: now.toISOString() },
          ipAddress,
        },
        tx as any,
      );
    });

    return { deleted: true, id: reportId };
  }

  async listSites() {
    return this.prisma.site.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, entityId: true, name: true, location: true, timezone: true },
    });
  }

  async listPolicies(viewer: FieldReportViewer) {
    let entityId: string | null = null;
    if (viewer.employeeId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: viewer.employeeId },
        select: { entityId: true },
      });
      entityId = emp?.entityId ?? null;
    }

    const effectivePolicy = await this.policyService.resolveEffectivePolicy(viewer, entityId);
    const canManage =
      this.accessService.isHrOrAdmin(viewer.roles) ||
      viewer.permissions.includes('FIELD_REPORT:MANAGE');

    if (!canManage) {
      return { effectivePolicy, policies: [] };
    }

    const policies = await this.prisma.fieldReportPolicy.findMany({
      orderBy: [{ entityId: 'asc' }, { roleName: 'asc' }],
    });
    return { effectivePolicy, policies };
  }

  async upsertPolicy(
    dto: UpdateFieldReportPolicyDto,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const entityId = dto.entityId?.trim() || null;
    const roleName = dto.roleName?.trim() || null;

    const existing = await this.prisma.fieldReportPolicy.findFirst({
      where: { entityId, roleName },
    });

    const data = {
      entityId,
      roleName,
      defaultDownloadVariant: dto.defaultDownloadVariant,
      allowOriginalDownload: dto.allowOriginalDownload,
      retentionDaysOverride: dto.retentionDaysOverride ?? null,
      requireGpsForCategories: dto.requireGpsForCategories ?? [],
      updatedByUserId: viewer.userId,
    };

    const saved = await this.prisma.$transaction(async (tx) => {
      const row = existing
        ? await tx.fieldReportPolicy.update({ where: { id: existing.id }, data })
        : await tx.fieldReportPolicy.create({ data });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.UPDATE,
          entityType: 'FIELD_REPORT_POLICY',
          entityId: row.id,
          beforeState: existing ?? null,
          afterState: row,
          ipAddress,
        },
        tx as any,
      );
      return row;
    });

    return saved;
  }

  async listDelegations(viewer: FieldReportViewer) {
    const isHr = this.accessService.isHrOrAdmin(viewer.roles);
    const where: any = isHr
      ? {}
      : viewer.employeeId
        ? {
            OR: [
              { delegatorEmployeeId: viewer.employeeId },
              { delegateEmployeeId: viewer.employeeId },
            ],
          }
        : { id: '___none___' };

    return this.prisma.fieldReportDelegation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        delegator: {
          select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        },
        delegate: {
          select: { id: true, firstName: true, lastName: true, employeeNumber: true },
        },
      },
    });
  }

  async createDelegation(
    dto: CreateDelegationDto,
    viewer: FieldReportViewer,
    ipAddress?: string,
  ) {
    const isHr = this.accessService.isHrOrAdmin(viewer.roles);
    const delegatorEmployeeId =
      dto.delegatorEmployeeId && isHr ? dto.delegatorEmployeeId : viewer.employeeId;

    if (dto.delegatorEmployeeId && !isHr && dto.delegatorEmployeeId !== viewer.employeeId) {
      throw new ForbiddenException({
        message: 'Managers may only delegate their own review authority.',
        error: 'FORBIDDEN',
      });
    }
    if (!delegatorEmployeeId) {
      throw new BadRequestException('Delegator employeeId is required.');
    }
    if (delegatorEmployeeId === dto.delegateEmployeeId) {
      throw new BadRequestException('Cannot delegate review authority to yourself.');
    }

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new BadRequestException('Delegation endsAt must be after startsAt.');
    }

    const [delegator, delegate] = await Promise.all([
      this.prisma.employee.findFirst({ where: { id: delegatorEmployeeId, deletedAt: null } }),
      this.prisma.employee.findFirst({ where: { id: dto.delegateEmployeeId, deletedAt: null } }),
    ]);
    if (!delegator || !delegate) {
      throw new NotFoundException('Delegator or delegate employee not found.');
    }

    const delegation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.fieldReportDelegation.create({
        data: {
          delegatorEmployeeId,
          delegateEmployeeId: dto.delegateEmployeeId,
          entityId: dto.entityId ?? null,
          startsAt,
          endsAt,
          reason: dto.reason?.trim() ?? null,
          isActive: true,
          createdByUserId: viewer.userId,
        },
        include: {
          delegator: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
          delegate: {
            select: { id: true, firstName: true, lastName: true, employeeNumber: true },
          },
        },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.CREATE,
          entityType: 'FIELD_REPORT_DELEGATION',
          entityId: created.id,
          afterState: {
            delegatorEmployeeId,
            delegateEmployeeId: dto.delegateEmployeeId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
          },
          ipAddress,
        },
        tx as any,
      );

      return created;
    });

    if (delegate.userId) {
      await this.notificationsService.notify({
        userId: delegate.userId,
        template: 'field-report-delegation-created',
        title: `Field Report review delegated to you by ${delegator.firstName} ${delegator.lastName}`,
        message: `Active from ${startsAt.toLocaleDateString()} to ${endsAt.toLocaleDateString()}.`,
        linkUrl: '/field-reports?tab=team',
        idempotencyKey: `fr-delegation:${delegation.id}`,
      });
    }

    return delegation;
  }

  async revokeDelegation(id: string, viewer: FieldReportViewer, ipAddress?: string) {
    const delegation = await this.prisma.fieldReportDelegation.findUnique({ where: { id } });
    if (!delegation) {
      throw new NotFoundException('Delegation not found.');
    }

    const isHr = this.accessService.isHrOrAdmin(viewer.roles);
    if (!isHr && delegation.delegatorEmployeeId !== viewer.employeeId) {
      throw new ForbiddenException('You cannot revoke another manager’s delegation.');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.fieldReportDelegation.update({
        where: { id },
        data: {
          isActive: false,
          revokedByUserId: viewer.userId,
          revokedAt: now,
        },
      });

      await this.auditService.log(
        {
          actorId: viewer.userId,
          actorEmail: viewer.email,
          action: AuditAction.DELETE,
          entityType: 'FIELD_REPORT_DELEGATION',
          entityId: id,
          afterState: { revokedAt: now.toISOString() },
          ipAddress,
        },
        tx as any,
      );

      return row;
    });

    return updated;
  }
}

