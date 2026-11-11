import { Injectable } from '@nestjs/common';
import { FieldReportCategory, FieldReportDownloadVariant, SystemRole } from '@ems/shared';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { FieldReportViewer } from './field-report-access.service';

export interface EffectiveDownloadPolicy {
  defaultDownloadVariant: FieldReportDownloadVariant;
  allowOriginalDownload: boolean;
  hasDownloadOriginalPermission: boolean;
  canDownloadOriginal: boolean;
  requireGpsForCategories: FieldReportCategory[];
}

@Injectable()
export class FieldReportPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveEffectivePolicy(
    viewer: Pick<FieldReportViewer, 'roles' | 'permissions'>,
    entityId: string | null,
  ): Promise<EffectiveDownloadPolicy> {
    const roles = viewer.roles ?? [];
    const permissions = viewer.permissions ?? [];
    const hasPerm =
      roles.includes(SystemRole.SUPER_ADMIN) ||
      permissions.includes('FIELD_REPORT:DOWNLOAD_ORIGINAL');

    const candidates = await this.prisma.fieldReportPolicy.findMany({
      where: {
        OR: [{ entityId: null }, ...(entityId ? [{ entityId }] : [])],
      },
    });

    const findBestForRole = (roleName: string) => {
      if (entityId) {
        const exact = candidates.find(
          (c) => c.entityId === entityId && c.roleName === roleName,
        );
        if (exact) return exact;
      }
      return candidates.find((c) => c.entityId === null && c.roleName === roleName);
    };

    const roleMatches = roles
      .map((r) => findBestForRole(r))
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    let effectiveRows = roleMatches;
    if (effectiveRows.length === 0) {
      const entityDefault = entityId
        ? candidates.find((c) => c.entityId === entityId && c.roleName === null)
        : undefined;
      const globalDefault = candidates.find(
        (c) => c.entityId === null && c.roleName === null,
      );
      const fallback = entityDefault ?? globalDefault;
      effectiveRows = fallback ? [fallback] : [];
    }

    if (effectiveRows.length === 0) {
      return {
        defaultDownloadVariant: FieldReportDownloadVariant.RESIZED,
        allowOriginalDownload: false,
        hasDownloadOriginalPermission: hasPerm,
        canDownloadOriginal: false,
        requireGpsForCategories: [],
      };
    }

    const allowOriginalByPolicy = effectiveRows.some((r) => r.allowOriginalDownload);
    const canDownloadOriginal = allowOriginalByPolicy && hasPerm;

    const prefersOriginal = effectiveRows.some(
      (r) =>
        r.defaultDownloadVariant === FieldReportDownloadVariant.ORIGINAL &&
        r.allowOriginalDownload,
    );

    const defaultDownloadVariant =
      prefersOriginal && canDownloadOriginal
        ? FieldReportDownloadVariant.ORIGINAL
        : FieldReportDownloadVariant.RESIZED;

    const requireGpsSet = new Set<FieldReportCategory>();
    for (const row of candidates) {
      if (row.roleName === null && Array.isArray(row.requireGpsForCategories)) {
        for (const cat of row.requireGpsForCategories) {
          requireGpsSet.add(cat as FieldReportCategory);
        }
      }
    }

    return {
      defaultDownloadVariant,
      allowOriginalDownload: allowOriginalByPolicy,
      hasDownloadOriginalPermission: hasPerm,
      canDownloadOriginal,
      requireGpsForCategories: Array.from(requireGpsSet),
    };
  }
}

