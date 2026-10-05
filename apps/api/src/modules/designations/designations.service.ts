import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CreateDesignationDto, UpdateDesignationDto } from './dto/designation.dto';
import { AuditAction } from '@ems/shared';

/** Allowlisted sortBy fields for GET /designations (query-param injection safe). */
export const DESIGNATION_SORT_FIELDS = ['title', 'code', 'level', 'createdAt', 'updatedAt'] as const;

export interface DesignationListQuery {
  departmentId?: string;
  entityId?: string;
  sortBy?: string;
  sortOrder?: string;
}

@Injectable()
export class DesignationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(query?: DesignationListQuery | string) {
    // Back-compat: the old signature accepted a bare departmentId string.
    const q: DesignationListQuery = typeof query === 'string' ? { departmentId: query } : (query ?? {});
    const sortBy = DESIGNATION_SORT_FIELDS.includes(q.sortBy as any) ? q.sortBy : 'level';
    const sortOrder = q.sortOrder === 'asc' ? 'asc' : 'desc';

    return this.prisma.designation.findMany({
      where: {
        deletedAt: null,
        ...(q.departmentId && { departmentId: q.departmentId }),
        // Phase 3, item 1 — Designation has no own entityId column; scope via
        // its department's entity (worker 4 migration added Department.entityId).
        ...(q.entityId && { department: { entityId: q.entityId } }),
      },
      include: {
        department: true,
        _count: { select: { employees: true } },
      },
      orderBy: { [sortBy!]: sortOrder },
    });
  }

  async findOne(id: string) {
    const desig = await this.prisma.designation.findFirst({
      where: { id, deletedAt: null },
      include: { department: true, employees: true },
    });
    if (!desig) {
      throw new NotFoundException(`Designation #${id} not found`);
    }
    return desig;
  }

  async create(dto: CreateDesignationDto, actorId?: string, actorEmail?: string) {
    const existing = await this.prisma.designation.findUnique({
      where: { code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new ConflictException(`Designation code '${dto.code}' already exists`);
    }

    const created = await this.prisma.designation.create({
      data: {
        title: dto.title,
        code: dto.code.toUpperCase(),
        description: dto.description,
        level: dto.level ?? 1,
        departmentId: dto.departmentId,
      },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.CREATE,
      entityType: 'DESIGNATION',
      entityId: created.id,
      afterState: created,
    });

    return created;
  }

  async update(id: string, dto: Partial<UpdateDesignationDto>, actorId?: string, actorEmail?: string) {
    const existing = await this.findOne(id);
    const updated = await this.prisma.designation.update({
      where: { id },
      data: {
        title: dto.title,
        code: dto.code ? dto.code.toUpperCase() : undefined,
        description: dto.description,
        level: dto.level,
        departmentId: dto.departmentId,
      },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.UPDATE,
      entityType: 'DESIGNATION',
      entityId: id,
      beforeState: existing,
      afterState: updated,
    });

    return updated;
  }

  async remove(id: string, actorId?: string, actorEmail?: string) {
    const existing = await this.findOne(id);
    await this.prisma.designation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.log({
      actorId,
      actorEmail,
      action: AuditAction.DELETE,
      entityType: 'DESIGNATION',
      entityId: id,
      beforeState: existing,
    });

    return { message: 'Designation deleted successfully' };
  }
}
