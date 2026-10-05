import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { SystemRole } from '@ems/shared';

/** Bounded retries for the employee-number race (concurrent signups). */
const EMPLOYEE_NUMBER_MAX_ATTEMPTS = 5;

function isUniqueConflictOn(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) && target.includes(field);
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
        employee: true,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: {
          include: {
            role: {
              include: {
                permissions: {
                  include: {
                    permission: true,
                  },
                },
              },
            },
          },
        },
        employee: {
          include: {
            department: true,
            designation: true,
          },
        },
      },
    });
  }

  async createUser(
    email: string,
    passwordHash: string,
    firstName: string,
    lastName: string,
    roleNames: SystemRole[] = [SystemRole.EMPLOYEE],
  ) {
    const existing = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('A user with this email address already exists');
    }

    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
    });

    return this.prisma.$transaction(async (tx) => {
      let user;
      try {
        user = await tx.user.create({
          data: {
            email: email.toLowerCase(),
            passwordHash,
            roles: {
              create: roles.map((r) => ({ roleId: r.id })),
            },
          },
        });
      } catch (e) {
        // Email pre-check raced with a concurrent signup: surface a clean 409
        // instead of leaking a Prisma error.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('A user with this email address already exists');
        }
        throw e;
      }

      // Automatically scaffold employee profile record.
      // F11/F30 race fix: the old `count + 1` numbering collides under
      // concurrent signups (two transactions read the same count). Retry the
      // insert with a freshly re-read count on employeeNumber conflicts
      // instead of failing the whole registration.
      let employee;
      for (let attempt = 0; ; attempt++) {
        const count = await tx.employee.count();
        const employeeNumber = `EMP-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
        try {
          employee = await tx.employee.create({
            data: {
              employeeNumber,
              userId: user.id,
              firstName,
              lastName,
              email: email.toLowerCase(),
            },
          });
          break;
        } catch (e) {
          if (isUniqueConflictOn(e, 'employeeNumber') && attempt < EMPLOYEE_NUMBER_MAX_ATTEMPTS - 1) {
            continue;
          }
          throw e;
        }
      }

      return { user, employee };
    });
  }

  async updatePassword(userId: string, newPasswordHash: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });
  }
}
