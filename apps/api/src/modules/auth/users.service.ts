import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { SystemRole } from '@ems/shared';
import { UpdateUserDto } from './dto/users.dto';

/**
 * Admin user management (web UI: GET /auth/users, PATCH /auth/users/:id).
 *
 * - Safe projection everywhere: passwordHash, tokens and MFA secrets are
 *   never returned.
 * - Role assignment is SUPER_ADMIN-only (enforced in the controller via a
 *   service-level check on the caller's roles); HR_ADMIN may toggle
 *   isActive/emailVerified.
 * - Self-protection: an admin cannot deactivate themselves or change their
 *   own roles through this endpoint (no lockout-by-UI footgun).
 */
export interface SafeUser {
  id: string;
  email: string;
  isActive: boolean;
  emailVerified: boolean;
  roles: string[];
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  } | null;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toSafeUser(row: any): SafeUser {
    return {
      id: row.id,
      email: row.email,
      isActive: row.isActive,
      emailVerified: row.emailVerified,
      roles: (row.roles || []).map((ur: any) => ur.role.name),
      employee: row.employee
        ? {
            id: row.employee.id,
            firstName: row.employee.firstName,
            lastName: row.employee.lastName,
            employeeNumber: row.employee.employeeNumber,
          }
        : null,
      createdAt: row.createdAt,
    };
  }

  private userInclude() {
    return {
      roles: { include: { role: true } },
      employee: true,
    };
  }

  async listUsers(page = 1, limit = 50, search?: string): Promise<{ data: SafeUser[]; total: number; page: number; limit: number }> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || 50));
    const where = search
      ? { email: { contains: search.toLowerCase(), mode: 'insensitive' as const } }
      : {};

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: this.userInclude(),
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    return {
      data: rows.map((r) => this.toSafeUser(r)),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async updateUser(
    callerId: string,
    callerRoles: SystemRole[],
    userId: string,
    dto: UpdateUserDto,
  ): Promise<SafeUser> {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      include: this.userInclude(),
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }

    if (callerId === userId && (dto.isActive === false || dto.roles !== undefined)) {
      throw new BadRequestException('You cannot deactivate yourself or change your own roles');
    }

    const data: Record<string, any> = {};
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.emailVerified !== undefined) data.emailVerified = dto.emailVerified;

    let roleIds: string[] | undefined;
    if (dto.roles !== undefined) {
      if (!callerRoles.includes(SystemRole.SUPER_ADMIN)) {
        throw new ForbiddenException('Only SUPER_ADMIN can change role assignments');
      }
      const normalized = [...new Set(dto.roles.map((r) => r.trim().toUpperCase()))];
      const valid = Object.values(SystemRole) as string[];
      const invalid = normalized.filter((r) => !valid.includes(r));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid roles: ${invalid.join(', ')}`);
      }
      if (normalized.length === 0) {
        throw new BadRequestException('A user must have at least one role');
      }
      const roleRows = await this.prisma.role.findMany({
        where: { name: { in: normalized as SystemRole[] } },
      });
      if (roleRows.length !== normalized.length) {
        throw new BadRequestException('One or more roles are not seeded in the database');
      }
      roleIds = roleRows.map((r) => r.id);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (roleIds !== undefined) {
        await tx.userRole.deleteMany({ where: { userId } });
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId, roleId })),
        });
      }
      // Prisma rejects update() with an empty data object — only touch the
      // row when flags actually changed, then re-read with relations.
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: userId }, data });
      }
      return tx.user.findUnique({
        where: { id: userId },
        include: this.userInclude(),
      });
    });

    if (!updated) {
      throw new NotFoundException('User not found');
    }
    this.logger.log(`User ${userId} updated by ${callerId}`);
    return this.toSafeUser(updated);
  }
}
