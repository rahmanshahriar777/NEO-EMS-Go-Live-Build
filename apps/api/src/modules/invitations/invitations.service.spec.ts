import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { EmailService } from '../../common/email/email.service';
import { SystemRole } from '@ems/shared';
import * as crypto from 'crypto';

/**
 * InvitationsService tests (B2): HR creates → emailed token link → accept
 * sets password, links employee, marks verified. The Invitation table is
 * provided by worker 4's migration; here it is mocked via
 * `(prisma as any).invitation`.
 */
describe('InvitationsService', () => {
  let service: InvitationsService;
  let prisma: any;
  let passwordService: { hash: jest.Mock };
  let emailService: { sendTemplated: jest.Mock };
  let configGet: jest.Mock;

  const invitation = (overrides: Record<string, any> = {}) => ({
    id: 'inv-1',
    email: 'new.hire@ems.local',
    tokenHash: crypto.createHash('sha256').update('raw-token').digest('hex'),
    role: 'EMPLOYEE',
    employeeId: null,
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    acceptedAt: null,
    createdById: 'hr-1',
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      employee: { findUnique: jest.fn() },
      role: { findUnique: jest.fn() },
      invitation: {
        create: jest.fn((args: any) => Promise.resolve({ id: 'inv-1', ...args.data })),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: 1001 }]),
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    passwordService = { hash: jest.fn().mockResolvedValue('argon2-hash') };
    emailService = { sendTemplated: jest.fn().mockResolvedValue('job-1') };
    configGet = jest.fn((key: string, fallback?: any) => {
      if (key === 'invitations.ttlHours') return 72;
      if (key === 'frontendUrl') return 'http://localhost:3000';
      return fallback;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwordService },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<InvitationsService>(InvitationsService);
  });

  describe('createInvitation', () => {
    it('creates the invitation and emails the accept link (never returns the raw token)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);

      const result = await service.createInvitation('hr-1', {
        email: 'New.Hire@ems.local',
        role: 'employee',
      });

      expect(result.email).toBe('new.hire@ems.local');
      expect(result.role).toBe(SystemRole.EMPLOYEE);
      expect(result).not.toHaveProperty('token');

      const stored = prisma.invitation.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.acceptedAt).toBeUndefined();

      const emailed = emailService.sendTemplated.mock.calls[0][0];
      expect(emailed.to).toBe('new.hire@ems.local');
      expect(emailed.template).toBe('invitation');
      expect(emailed.data.actionUrl).toContain('http://localhost:3000/invitation-accept?token=');
      const rawFromUrl = emailed.data.actionUrl.split('token=')[1];
      expect(crypto.createHash('sha256').update(rawFromUrl).digest('hex')).toBe(stored.tokenHash);
    });

    it('emailed invitation link targets the real /invitation-accept web route', async () => {
      // Regression: the service once emailed /accept-invitation, a page
      // that does not exist — every invitation 404'd. The only accept page
      // in the web app is app/(auth)/invitation-accept.
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);

      await service.createInvitation('hr-1', {
        email: 'New.Hire@ems.local',
        role: 'employee',
      });

      const emailed = emailService.sendTemplated.mock.calls[0][0];
      const url = new URL(emailed.data.actionUrl);
      expect(url.pathname).toBe('/invitation-accept');
      expect(url.searchParams.get('token')).toBeTruthy();
    });

    it('rejects when a user already exists for the email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-x' });

      await expect(
        service.createInvitation('hr-1', { email: 'taken@ems.local', role: 'EMPLOYEE' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects a duplicate active invitation', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(invitation());

      await expect(
        service.createInvitation('hr-1', { email: 'new.hire@ems.local', role: 'EMPLOYEE' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid role', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.createInvitation('hr-1', { email: 'x@ems.local', role: 'CEO' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts an existing custom role from the database', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.role.findFirst = jest.fn().mockResolvedValue({ id: 'r-1', name: 'PAYROLL_OFFICER' });

      const res = await service.createInvitation('hr-1', {
        email: 'officer@ems.local',
        role: 'PAYROLL_OFFICER',
      });

      expect(res.role).toBe('PAYROLL_OFFICER');
    });

    it('rejects an employeeId that does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.invitation.findFirst.mockResolvedValue(null);
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.createInvitation('hr-1', { email: 'x@ems.local', role: 'EMPLOYEE', employeeId: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('forbids inviting SUPER_ADMIN when the creator is not SUPER_ADMIN', async () => {
      // Creator lookup is the first user.findUnique call for a SUPER_ADMIN invite.
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'hr-1',
        roles: [{ role: { name: 'HR_ADMIN' } }],
      });

      await expect(
        service.createInvitation('hr-1', { email: 'boss@ems.local', role: 'SUPER_ADMIN' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.invitation.create).not.toHaveBeenCalled();
    });

    it('allows a SUPER_ADMIN creator to invite SUPER_ADMIN', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({
          id: 'root-1',
          roles: [{ role: { name: 'SUPER_ADMIN' } }],
        })
        .mockResolvedValueOnce(null); // email check: no existing user
      prisma.invitation.findFirst.mockResolvedValue(null);

      const result = await service.createInvitation('root-1', {
        email: 'boss@ems.local',
        role: 'SUPER_ADMIN',
      });

      expect(result.role).toBe(SystemRole.SUPER_ADMIN);
      expect(prisma.invitation.create).toHaveBeenCalled();
    });
  });

  describe('acceptInvitation', () => {
    beforeEach(() => {
      prisma.invitation.findUnique.mockResolvedValue(invitation());
      // Atomic claim succeeds by default; losers/expired/used override to { count: 0 }.
      prisma.invitation.updateMany.mockResolvedValue({ count: 1 });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-emp', name: 'EMPLOYEE' });
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create = jest.fn((args: any) => Promise.resolve({ id: 'user-new', ...args.data }));
      prisma.employee.create = jest.fn((args: any) => Promise.resolve({ id: 'emp-new', ...args.data }));
      prisma.employee.count = jest.fn().mockResolvedValue(0);
    });

    it('accepts a valid token: creates a verified user, scaffolds the employee, consumes the invitation', async () => {
      const result = await service.acceptInvitation({
        token: 'raw-token',
        password: 'LongEnoughPassword123!',
        firstName: 'Jane',
        lastName: 'Smith',
      });

      expect(result.userId).toBe('user-new');
      expect(passwordService.hash).toHaveBeenCalledWith('LongEnoughPassword123!');

      const userData = prisma.user.create.mock.calls[0][0].data;
      expect(userData.email).toBe('new.hire@ems.local');
      expect(userData.emailVerified).toBe(true);
      expect(userData.passwordHash).toBe('argon2-hash');

      expect(prisma.invitation.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: expect.any(String),
          acceptedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        data: { acceptedAt: expect.any(Date) },
      });
    });

    it('links an existing employee record when employeeId is set', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitation({ employeeId: 'emp-9' }));
      prisma.employee.findUnique.mockResolvedValue({ id: 'emp-9', userId: null });
      prisma.employee.update = jest.fn().mockResolvedValue({});

      await service.acceptInvitation({
        token: 'raw-token',
        password: 'LongEnoughPassword123!',
        firstName: 'Jane',
        lastName: 'Smith',
      });

      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { id: 'emp-9' },
        data: { userId: 'user-new' },
      });
      expect(prisma.employee.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      prisma.invitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.acceptInvitation({ token: 'nope', password: 'LongEnoughPassword123!', firstName: 'J', lastName: 'S' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an already-accepted invitation', async () => {
      prisma.invitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.acceptInvitation({ token: 'raw-token', password: 'LongEnoughPassword123!', firstName: 'J', lastName: 'S' }),
      ).rejects.toThrow(/already used/i);
    });

    it('rejects an expired invitation', async () => {
      prisma.invitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.acceptInvitation({ token: 'raw-token', password: 'LongEnoughPassword123!', firstName: 'J', lastName: 'S' }),
      ).rejects.toThrow(/expired/i);
    });
  });

  describe('revokeInvitation', () => {
    it('deletes a pending invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitation());

      await service.revokeInvitation('inv-1');

      expect(prisma.invitation.delete).toHaveBeenCalledWith({ where: { id: 'inv-1' } });
    });

    it('refuses to revoke an accepted invitation', async () => {
      prisma.invitation.findUnique.mockResolvedValue(invitation({ acceptedAt: new Date() }));

      await expect(service.revokeInvitation('inv-1')).rejects.toThrow(BadRequestException);
      expect(prisma.invitation.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown ids', async () => {
      prisma.invitation.findUnique.mockResolvedValue(null);

      await expect(service.revokeInvitation('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
