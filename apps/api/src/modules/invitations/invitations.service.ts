import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { EmailService } from '../../common/email/email.service';
import { SystemRole, nextEmployeeNumber } from '@ems/shared';
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
  ) {}

  private invitationDelegate() {
    return (this.prisma as any).invitation;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private resolveRole(role: string): SystemRole {
    const normalized = role.trim().toUpperCase();
    if (!(Object.values(SystemRole) as string[]).includes(normalized)) {
      throw new BadRequestException(
        `Invalid role '${role}'. Must be one of: ${Object.values(SystemRole).join(', ')}`,
      );
    }
    return normalized as SystemRole;
  }

  /**
   * HR creates an invitation. Returns the invitation metadata — NEVER the raw
   * token (it travels only inside the emailed link).
   */
  async createInvitation(
    createdById: string,
    dto: CreateInvitationDto,
  ): Promise<{ id: string; email: string; role: SystemRole; expiresAt: Date; inviteUrl: string }> {
    const rawRole = dto.role || (Array.isArray(dto.roleIds) && dto.roleIds[0]);
    if (!rawRole) {
      throw new BadRequestException('role should not be empty');
    }
    const email = dto.email.toLowerCase().trim();
    const role = this.resolveRole(rawRole);

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
   * Accept an invitation: validate the single-use token, create the user with
   * an Argon2id password hash (policy enforced), link or scaffold the
   * employee record, and mark the invitation consumed — atomically.
   * The email is marked verified: receiving the token link proves ownership.
   */
  async acceptInvitation(dto: AcceptInvitationDto): Promise<{ userId: string; email: string }> {
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

      const role = this.resolveRole(invitation.role);
      const roleRow = await tx.role.findUnique({ where: { name: role } });
      if (!roleRow) {
        throw new BadRequestException(`Role '${role}' is not seeded in the database`);
      }

      const existingUser = await tx.user.findUnique({ where: { email: invitation.email } });
      if (existingUser) {
        throw new ConflictException('A user with this email address already exists');
      }

      // 12-char minimum + breach screening enforced inside hash().
      const passwordHash = await this.passwordService.hash(dto.password);

      const user = await tx.user.create({
        data: {
          email: invitation.email,
          passwordHash,
          emailVerified: true,
          roles: { create: [{ roleId: roleRow.id }] },
        },
      });

      if (invitation.employeeId) {
        const employee = await tx.employee.findUnique({
          where: { id: invitation.employeeId },
          select: { id: true, userId: true },
        });
        if (!employee) {
          throw new NotFoundException('Linked employee record not found');
        }
        if (employee.userId) {
          throw new ConflictException('This employee record is already linked to a user');
        }
        await tx.employee.update({
          where: { id: invitation.employeeId },
          data: { userId: user.id },
        });
      } else {
        // Scaffold an employee profile with a sequence-backed number
        // (go-live Phase 1 item 6 — never count()+1, race-safe).
        // v4 fix #9: contractStart = joiningDate (single clock read) so a
        // mid-month joiner is prorated, not paid a full month.
        const employeeNumber = await nextEmployeeNumber((sql: string) =>
          tx.$queryRawUnsafe(sql),
        );
        const joinedAt = new Date();
        await tx.employee.create({
          data: {
            employeeNumber,
            userId: user.id,
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: invitation.email,
            joiningDate: joinedAt,
            contractStart: joinedAt,
          },
        });
      }

      this.logger.log(`Invitation ${invitation.id} accepted — user ${user.id} created`);
      return { userId: user.id, email: invitation.email };
    });
  }
}
