import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { SystemRole, nextEmployeeNumber } from '@ems/shared';

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

      // Automatically scaffold employee profile record. Race-free employee
      // number via the employee_number_seq Postgres sequence (go-live
      // Phase 1 item 6) — the same shared nextEmployeeNumber() helper used by
      // employees.service.create and the recruitment offer-accept path.
      // nextval() is atomic, so concurrent signups can never collide, and
      // soft-deleted employees' numbers are never re-issued.
      const employeeNumber = await nextEmployeeNumber((sql: string) =>
        tx.$queryRawUnsafe(sql),
      );
      const employee = await tx.employee.create({
        data: {
          employeeNumber,
          userId: user.id,
          firstName,
          lastName,
          email: email.toLowerCase(),
        },
      });

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
