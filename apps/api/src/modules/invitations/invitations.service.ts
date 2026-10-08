import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { EmailService } from '../../common/email/email.service';
import { SystemRole, TokensResponse, nextEmployeeNumber } from '@ems/shared';
import { CreateInvitationDto, AcceptInvitationDto } from './dto/invitation.dto';

/**
 * B2 — invitation-based onboarding.
 *
 * HR creates an invitation by email → the invitee gets a single-use token
 * link → accepting sets their password, creates (or links) the user +
 * employee record, and marks the email verified (the token link proves
 * address ownership — no separate verification step needed).
 *
 * Prisma table needed (worker 4 — migration + client regeneration):
 *   model Invitation {
 *     id          String    @id @default(uuid())
 *     email       String
 *     tokenHash   String    @unique
 *     role        String
 *     employeeId  String?
 *     expiresAt   DateTime
 *     acceptedAt  DateTime?
 *     createdById String
 *     createdAt   DateTime  @default(now())
 *     @@index([email])
 *     @@map("invitations")
 *   }
 * Until the migration lands, all access goes through the structural
 * `InvitationRecord` type below via `(prisma as any).invitation`.
 */
export interface InvitationRecord {
  id: string;
  email: string;
  tokenHash: string;
  role: string;
  employeeId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    @Optional() private readonly tokenService?: TokenService,
  ) {}

  private invitationDelegate() {
    return (this.prisma as any).invitation;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async resolveRole(role: string): Promise<string> {
    const trimmed = role.trim();
    const normalized = trimmed.toUpperCase();
    if ((Object.values(SystemRole) as string[]).includes(normalized)) {
      return normalized;
    }
    if (this.prisma.role?.findFirst) {
      const customRole = await this.prisma.role.findFirst({
        where: {
          OR: [{ name: trimmed }, { name: normalized }],
        },
      });
      if (customRole) {
        return customRole.name;
      }
    }
    throw new BadRequestException(
      `Invalid role '${role}'. Must be one of: ${Object.values(SystemRole).join(', ')} or an existing custom role.`,
    );
  }

  /**
   * HR creates an invitation. Returns the invitation metadata — NEVER the raw
   * token (it travels only inside the emailed link).
   */
  async createInvitation(
    createdById: string,
    dto: CreateInvitationDto,
  ): Promise<{ id: string; email: string; role: string; expiresAt: Date; inviteUrl: string }> {
    const rawRole = dto.role || (Array.isArray(dto.roleIds) && dto.roleIds[0]);
    if (!rawRole) {
      throw new BadRequestException('role should not be empty');
    }
    const email = dto.email.toLowerCase().trim();
    const role = await this.resolveRole(rawRole);

    // Go-live Phase 1 item 7 — invitation privilege escalation gate: only a
    // SUPER_ADMIN may invite another SUPER_ADMIN. The creator's roles are
    // loaded (not trusted from the JWT) so a forged role claim cannot mint
    // super-admin accounts.
    if (role === SystemRole.SUPER_ADMIN) {
      const creator = await this.prisma.user.findUnique({
        where: { id: createdById },
        include: { roles: { include: { role: { select: { name: true } } } } },
      });
      const creatorRoles = (creator?.roles ?? []).map((ur: any) => ur.role?.name);
      if (!creatorRoles.includes(SystemRole.SUPER_ADMIN)) {
        throw new ForbiddenException('Only a SUPER_ADMIN may invite another SUPER_ADMIN');
      }
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException('A user with this email address already exists');
    }

    const activeInvite: InvitationRecord | null = await this.invitationDelegate().findFirst({
      where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    if (activeInvite) {
      throw new ConflictException('An active invitation already exists for this email address');
    }

    if (dto.employeeId) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: dto.employeeId },
        select: { id: true, userId: true },
      });
      if (!employee) {
        throw new NotFoundException('Employee record not found');
      }
      if (employee.userId) {
        throw new ConflictException('This employee record is already linked to a user');
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const ttlHours = this.configService.get<number>('invitations.ttlHours', 72);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const invitation: InvitationRecord = await this.invitationDelegate().create({
      data: {
        email,
        tokenHash,
        role,
        employeeId: dto.employeeId ?? null,
        expiresAt,
        createdById,
      },
    });

    const frontendUrl = this.configService.get<string>('frontendUrl', 'http://localhost:3000');
    const actionUrl = `${frontendUrl}/invitation-accept?token=${token}`;
    await this.emailService.sendTemplated({
      // No user row exists yet for the invitee: the inviter's id is the
      // notification-job routing key (worker contract requires userId); the
      // worker resolves the recipient from data.email.
      to: email,
      userId: createdById,
      template: 'invitation',
      data: {
        actionUrl,
        role,
        expiresNote: `${ttlHours} hours`,
      },
      idempotencyKey: `invitation:${tokenHash}`,
      title: `Invitation to join NEO EMS (${role})`,
    });

    this.logger.log(`Invitation ${invitation.id} created for ${email} by ${createdById}`);
    return { id: invitation.id, email, role, expiresAt, inviteUrl: actionUrl };
  }

  async listInvitations(): Promise<InvitationRecord[]> {
    return this.invitationDelegate().findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async revokeInvitation(id: string): Promise<void> {
    const invitation: InvitationRecord | null = await this.invitationDelegate().findUnique({
      where: { id },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.acceptedAt) {
      throw new BadRequestException('Invitation has already been accepted and cannot be revoked');
    }
    await this.invitationDelegate().delete({ where: { id } });
    this.logger.log(`Invitation ${id} revoked`);
  }

  /**
   * Verify an invitation token before display on the accept page.
   * Gives instant feedback on whether the link is valid, expired, or already used.
   */
  async verifyInvitation(token: string): Promise<{
    valid: boolean;
    reason?: 'INVALID' | 'ALREADY_ACCEPTED' | 'EXPIRED';
    message: string;
    email?: string;
    role?: string;
    expiresAt?: Date;
    firstName?: string;
    lastName?: string;
  }> {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return {
        valid: false,
        reason: 'INVALID',
        message: 'No invitation token was provided.',
      };
    }
    const tokenHash = this.hashToken(token.trim());
    const invitation: InvitationRecord | null = await this.invitationDelegate().findUnique({
      where: { tokenHash },
    });

    if (!invitation) {
      return {
        valid: false,
        reason: 'INVALID',
        message: 'This invitation link is invalid or does not exist.',
      };
    }

    if (invitation.acceptedAt) {
      return {
        valid: false,
        reason: 'ALREADY_ACCEPTED',
        message: 'This invitation has already been accepted. You can log in directly.',
        email: invitation.email,
        role: invitation.role,
      };
    }

    if (invitation.expiresAt && invitation.expiresAt <= new Date()) {
      return {
        valid: false,
        reason: 'EXPIRED',
        message: 'This invitation link has expired. Please contact your administrator for a new one.',
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      };
    }

    let firstName: string | undefined;
    let lastName: string | undefined;
    if (invitation.employeeId) {
      try {
        const emp = await this.prisma.employee.findUnique({
          where: { id: invitation.employeeId },
          select: { firstName: true, lastName: true },
        });
        if (emp) {
          firstName = emp.firstName;
          lastName = emp.lastName;
        }
      } catch (err: any) {
        this.logger.debug(`Could not look up employee name for invitation: ${err?.message}`);
      }
    }

    return {
      valid: true,
      message: 'Invitation is valid.',
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      firstName,
      lastName,
    };
  }

  /**
   * Accept an invitation: validate the single-use token, create or activate the user with
   * an Argon2id password hash (policy enforced), link or scaffold the
   * employee record, and mark the invitation consumed — atomically.
   * The email is marked verified: receiving the token link proves ownership.
   */
  async acceptInvitation(
    dto: AcceptInvitationDto,
    ipAddress?: string,
  ): Promise<{
    userId: string;
    email: string;
    user?: any;
    tokens?: TokensResponse;
  }> {
    const tokenHash = this.hashToken(dto.token);
    const now = new Date();

    return this.prisma.$transaction(async (tx: any) => {
      // Atomic single-use claim FIRST: exactly one concurrent accepter wins.
      // The conditional update (acceptedAt: null) is the linearization point;
      // losers see count 0 and get the same "invalid/used/expired" error.
      const claimed = await tx.invitation.updateMany({
        where: { tokenHash, acceptedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Invitation token is invalid, already used, or has expired.');
      }

      const invitation: InvitationRecord | null = await tx.invitation.findUnique({
        where: { tokenHash },
      });
      if (!invitation) {
        // Unreachable in practice (we just claimed it) — defensive.
        throw new BadRequestException('Invitation token is invalid, already used, or has expired.');
      }

      const role = await this.resolveRole(invitation.role);
      const roleRow =
        (await tx.role.findUnique({ where: { name: role } })) ||
        (tx.role.findFirst ? await tx.role.findFirst({ where: { name: role } }) : null);
      if (!roleRow) {
        throw new BadRequestException(`Role '${role}' is not found in the database`);
      }

      const normalizedEmail = invitation.email.toLowerCase().trim();
      const existingUser = await tx.user.findUnique({ where: { email: normalizedEmail } });

      // 12-char minimum + breach screening enforced inside hash().
      const passwordHash = await this.passwordService.hash(dto.password);

      let user: any;
      if (existingUser) {
        user = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            passwordHash,
            emailVerified: true,
            isActive: true,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
        if (tx.userRole?.create) {
          try {
            await tx.userRole.create({
              data: { userId: user.id, roleId: roleRow.id },
            });
          } catch {
            // Already has role or constraint
          }
        }
      } else {
        user = await tx.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            emailVerified: true,
            roles: { create: [{ roleId: roleRow.id }] },
          },
        });
      }

      let employeeRecord: any = null;
      if (invitation.employeeId) {
        const employee = await tx.employee.findUnique({
          where: { id: invitation.employeeId },
          select: { id: true, userId: true },
        });
        if (!employee) {
          throw new NotFoundException('Linked employee record not found');
        }
        if (employee.userId && employee.userId !== user.id) {
          throw new ConflictException('This employee record is already linked to a user');
        }
        employeeRecord = await tx.employee.update({
          where: { id: invitation.employeeId },
          data: { userId: user.id },
        });
      } else {
        const existingEmployee = tx.employee.findFirst
          ? await tx.employee.findFirst({ where: { email: normalizedEmail } })
          : null;
        if (existingEmployee) {
          employeeRecord = await tx.employee.update({
            where: { id: existingEmployee.id },
            data: {
              userId: user.id,
              firstName: dto.firstName?.trim() || existingEmployee.firstName,
              lastName: dto.lastName?.trim() || existingEmployee.lastName,
            },
          });
        } else {
          // Scaffold an employee profile with sequence-backed number (with graceful fallback)
          let employeeNumber: string;
          try {
            employeeNumber = await nextEmployeeNumber((sql: string) =>
              tx.$queryRawUnsafe(sql),
            );
          } catch (seqErr: any) {
            try {
              await tx.$queryRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS employee_number_seq START WITH 1000;`);
              employeeNumber = await nextEmployeeNumber((sql: string) =>
                tx.$queryRawUnsafe(sql),
              );
            } catch {
              const empCount = await tx.employee.count();
              const yr = new Date().getFullYear();
              employeeNumber = `EMP-${yr}-${String(1000 + empCount + 1).padStart(4, '0')}`;
            }
          }
          const joinedAt = new Date();
          employeeRecord = await tx.employee.create({
            data: {
              employeeNumber,
              userId: user.id,
              firstName: dto.firstName,
              lastName: dto.lastName,
              email: normalizedEmail,
              joiningDate: joinedAt,
              contractStart: joinedAt,
            },
          });
        }
      }

      // Generate session tokens if TokenService is available
      let tokens: TokensResponse | undefined;
      const systemRoles = [role as SystemRole];
      if (this.tokenService) {
        try {
          tokens = await this.tokenService.generateTokens(
            user.id,
            normalizedEmail,
            systemRoles,
            [],
            employeeRecord?.id,
            undefined,
            ipAddress,
          );
        } catch (tokenErr: any) {
          this.logger.warn(`Could not generate session tokens on invitation accept: ${tokenErr?.message}`);
        }
      }

      const userProfile = {
        id: user.id,
        email: normalizedEmail,
        firstName: employeeRecord?.firstName || dto.firstName?.trim(),
        lastName: employeeRecord?.lastName || dto.lastName?.trim(),
        roles: systemRoles,
        employeeId: employeeRecord?.id,
        employeeNumber: employeeRecord?.employeeNumber,
      };

      this.logger.log(`Invitation ${invitation.id} accepted — user ${user.id} activated`);
      return {
        userId: user.id,
        email: normalizedEmail,
        user: userProfile,
        tokens,
      };
    });
  }
}
