import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto';

export type RoleWithPermissionsRow = Prisma.RoleGetPayload<{
  include: { permissions: { include: { permission: true } } };
}>;

export interface RoleWithPermissions {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Parse 'SUBJECT:ACTION' into { subject, action }; 400 on malformed. */
  private parsePermission(value: string): { subject: string; action: string } {
    const parts = value.split(':');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new BadRequestException(
        `Invalid permission '${value}'. Expected SUBJECT:ACTION format, e.g. 'PAYROLL:READ'.`,
      );
    }
    return { subject: parts[0].trim().toUpperCase(), action: parts[1].trim().toUpperCase() };
  }

  /** Resolve SUBJECT:ACTION strings to permission ids; 400 on unknown. */
  private async resolvePermissionIds(values: string[]): Promise<string[]> {
    const unique = [...new Set(values.map((v) => v.trim().toUpperCase()))];
    const parsed = unique.map((v) => this.parsePermission(v));
    const rows = await this.prisma.permission.findMany({
      where: {
        OR: parsed.map((p) => ({ subject: p.subject, action: p.action })),
      },
    });
    const found = new Set(rows.map((r) => `${r.subject}:${r.action}`));
    const missing = unique.filter((v) => !found.has(v));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown permissions: ${missing.join(', ')}`);
    }
    return rows.map((r) => r.id);
  }

  private toRoleWithPermissions(row: RoleWithPermissionsRow): RoleWithPermissions {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      isSystem: row.isSystem,
      permissions: (row.permissions || []).map(
        (rp) => `${rp.permission.subject}:${rp.permission.action}`,
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private roleInclude() {
    return {
      permissions: { include: { permission: true } },
    } as const;
  }

  async listRoles(): Promise<RoleWithPermissions[]> {
    const rows = await this.prisma.role.findMany({
      include: this.roleInclude(),
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toRoleWithPermissions(r));
  }

  /** All seeded permissions in SUBJECT:ACTION format (role-editor source). */
  async listPermissions(): Promise<string[]> {
    const rows = await this.prisma.permission.findMany({
      orderBy: [{ subject: 'asc' }, { action: 'asc' }],
    });
    return rows.map((p) => `${p.subject}:${p.action}`);
  }

  async createRole(dto: CreateRoleDto): Promise<RoleWithPermissions> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Role name is required');
    }

    const existing = await this.prisma.role.findFirst({
      where: { name },
    });
    if (existing) {
      throw new ConflictException(`Role '${name}' already exists`);
    }

    const permissionIds = dto.permissions ? await this.resolvePermissionIds(dto.permissions) : [];

    const role = await this.prisma.role.create({
      data: {
        name,
        description: dto.description,
        isSystem: false,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
      include: this.roleInclude(),
    });

    this.logger.log(`Role '${name}' created with ${permissionIds.length} permissions`);
    return this.toRoleWithPermissions(role);
  }

  async updateRole(id: string, dto: UpdateRoleDto): Promise<RoleWithPermissions> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    let permissionIds: string[] | undefined;
    if (dto.permissions !== undefined) {
      permissionIds = await this.resolvePermissionIds(dto.permissions);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (permissionIds !== undefined) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
          });
        }
      }
      return tx.role.update({
        where: { id },
        data: { description: dto.description },
        include: this.roleInclude(),
      });
    });

    this.logger.log(`Role '${role.name}' updated`);
    return this.toRoleWithPermissions(updated);
  }

  async deleteRole(id: string): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { users: true },
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }
    if (role.users.length > 0) {
      throw new BadRequestException(
        `Role '${role.name}' is assigned to ${role.users.length} user(s) and cannot be deleted`,
      );
    }
    await this.prisma.role.delete({ where: { id } });
    this.logger.log(`Role '${role.name}' deleted`);
  }
}
