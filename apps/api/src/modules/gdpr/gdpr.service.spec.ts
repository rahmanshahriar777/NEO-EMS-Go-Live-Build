import { Test, TestingModule } from '@nestjs/testing';
import { GdprService } from './gdpr.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { EmployeesService } from '../employees/employees.service';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, JwtPayload, SystemRole } from '@ems/shared';
import { ErasureStatus } from '@ems/database';
import { ErasureDecision } from './dto/gdpr.dto';

const employeeViewer = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'employee@example.com',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

const hrViewer = (): JwtPayload => ({
  sub: 'hr-1',
  email: 'hr@example.com',
  roles: [SystemRole.HR_ADMIN],
  permissions: [],
  employeeId: 'emp-hr',
});

describe('GdprService', () => {
  let service: GdprService;
  let prisma: any;
  let employeesService: any;
  let auditService: any;

  beforeEach(async () => {
    prisma = {
      erasureRequest: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      employee: { findUnique: jest.fn() },
      attendanceRecord: { findMany: jest.fn(), count: jest.fn() },
      leaveRequest: { findMany: jest.fn() },
      document: { findMany: jest.fn() },
      payslip: { findMany: jest.fn() },
      performanceReview: { findMany: jest.fn() },
      goal: { findMany: jest.fn() },
      feedback: { findMany: jest.fn() },
      rosterEntry: { findMany: jest.fn() },
      $transaction: jest.fn((promises: Promise<any>[]) => Promise.all(promises)),
    };
    employeesService = { anonymizeEmployee: jest.fn() };
    auditService = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GdprService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmployeesService, useValue: employeesService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<GdprService>(GdprService);
  });

  describe('createErasureRequest', () => {
    it('rejects a second pending request for the same employee', async () => {
      prisma.erasureRequest.findFirst.mockResolvedValue({ id: 'req-existing' });

      await expect(
        service.createErasureRequest(employeeViewer(), { reason: 'leaving' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.erasureRequest.findFirst).toHaveBeenCalledWith({
        where: { employeeId: 'emp-1', status: ErasureStatus.PENDING },
        select: { id: true },
      });
      expect(prisma.erasureRequest.create).not.toHaveBeenCalled();
    });

    it('creates a request keyed to the caller employeeId', async () => {
      prisma.erasureRequest.findFirst.mockResolvedValue(null);
      prisma.erasureRequest.create.mockResolvedValue({ id: 'req-1', status: 'PENDING' });

      await service.createErasureRequest(employeeViewer(), { reason: 'leaving' });

      expect(prisma.erasureRequest.create).toHaveBeenCalledWith({
        data: { employeeId: 'emp-1', requestedById: 'user-1', reason: 'leaving' },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'ErasureRequest',
          entityId: 'req-1',
        }),
      );
    });

    it('requires an employee profile on the caller', async () => {
      await expect(
        service.createErasureRequest(employeeViewer({ employeeId: undefined }), {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reviewErasureRequest', () => {
    const pendingRequest = {
      id: 'req-1',
      employeeId: 'emp-1',
      status: ErasureStatus.PENDING,
      reason: 'leaving',
      employee: { id: 'emp-1', deletedAt: null },
    };

    it('APPROVE anonymises the employee, stores evidence and marks APPROVED', async () => {
      prisma.erasureRequest.findUnique.mockResolvedValue(pendingRequest);
      employeesService.anonymizeEmployee.mockResolvedValue({
        employeeId: 'emp-1',
        anonymizedFields: ['firstName'],
      });
      prisma.erasureRequest.update.mockResolvedValue({ id: 'req-1', status: 'APPROVED' });

      await service.reviewErasureRequest('req-1', hrViewer(), {
        decision: ErasureDecision.APPROVE,
      });

      expect(employeesService.anonymizeEmployee).toHaveBeenCalledWith('emp-1', 'hr-1', 'hr@example.com');
      expect(prisma.erasureRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1' },
          data: expect.objectContaining({
            status: ErasureStatus.APPROVED,
            reviewedById: 'hr-1',
            evidence: expect.objectContaining({
              employeeId: 'emp-1',
              reviewedById: 'hr-1',
            }),
          }),
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.APPROVE, entityType: 'ErasureRequest' }),
      );
    });

    it('REJECT without a reason is refused', async () => {
      prisma.erasureRequest.findUnique.mockResolvedValue(pendingRequest);

      await expect(
        service.reviewErasureRequest('req-1', hrViewer(), { decision: ErasureDecision.REJECT }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(employeesService.anonymizeEmployee).not.toHaveBeenCalled();
    });

    it('REJECT with a reason closes the request without anonymising', async () => {
      prisma.erasureRequest.findUnique.mockResolvedValue(pendingRequest);
      prisma.erasureRequest.update.mockResolvedValue({ id: 'req-1', status: 'REJECTED' });

      await service.reviewErasureRequest('req-1', hrViewer(), {
        decision: ErasureDecision.REJECT,
        reason: 'Statutory retention applies',
      });

      expect(employeesService.anonymizeEmployee).not.toHaveBeenCalled();
      expect(prisma.erasureRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ErasureStatus.REJECTED,
            reason: 'Statutory retention applies',
          }),
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.REJECT }),
      );
    });

    it('refuses to review an already-decided request', async () => {
      prisma.erasureRequest.findUnique.mockResolvedValue({
        ...pendingRequest,
        status: ErasureStatus.APPROVED,
      });

      await expect(
        service.reviewErasureRequest('req-1', hrViewer(), { decision: ErasureDecision.APPROVE }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(employeesService.anonymizeEmployee).not.toHaveBeenCalled();
    });

    it('404s on an unknown request id', async () => {
      prisma.erasureRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.reviewErasureRequest('nope', hrViewer(), { decision: ErasureDecision.APPROVE }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('exportMyData (DSAR)', () => {
    it('scopes every query to the caller employeeId — never another subject', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', employeeNumber: 'EMP-1' });
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.count.mockResolvedValue(0);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.document.findMany.mockResolvedValue([]);
      prisma.payslip.findMany.mockResolvedValue([]);
      prisma.performanceReview.findMany.mockResolvedValue([]);
      prisma.goal.findMany.mockResolvedValue([]);
      prisma.feedback.findMany.mockResolvedValue([]);
      prisma.rosterEntry.findMany.mockResolvedValue([]);

      const result = await service.exportMyData(employeeViewer());

      for (const delegate of [
        prisma.attendanceRecord,
        prisma.leaveRequest,
        prisma.document,
        prisma.payslip,
        prisma.performanceReview,
        prisma.goal,
        prisma.rosterEntry,
      ]) {
        expect(delegate.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ employeeId: 'emp-1' }) }),
        );
      }
      // Feedback is keyed by recipientId/senderId (same subject, different column).
      const feedbackWheres = prisma.feedback.findMany.mock.calls.map((c: any[]) => c[0].where);
      expect(feedbackWheres).toContainEqual({ recipientId: 'emp-1' });
      expect(feedbackWheres).toContainEqual({ senderId: 'emp-1' });
      expect(prisma.employee.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'emp-1' } }),
      );
      expect(result.subject).toEqual({ employeeId: 'emp-1', employeeNumber: 'EMP-1' });
      expect(result).toHaveProperty('profile');
      expect(result).toHaveProperty('payslips');
      expect(result).toHaveProperty('performanceReviews');
      expect(result).toHaveProperty('goals');
      expect(result).toHaveProperty('feedback');
      expect(result).toHaveProperty('roster');
    });

    it('paginates attendance instead of truncating at a hard cap', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', employeeNumber: 'EMP-1' });
      prisma.attendanceRecord.findMany.mockResolvedValue([{ id: 'a1' }]);
      prisma.attendanceRecord.count.mockResolvedValue(250);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.document.findMany.mockResolvedValue([]);
      prisma.payslip.findMany.mockResolvedValue([]);
      prisma.performanceReview.findMany.mockResolvedValue([]);
      prisma.goal.findMany.mockResolvedValue([]);
      prisma.feedback.findMany.mockResolvedValue([]);
      prisma.rosterEntry.findMany.mockResolvedValue([]);

      const result: any = await service.exportMyData(employeeViewer(), {
        attendancePage: 2,
        attendanceLimit: 100,
      });

      expect(prisma.attendanceRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 100, take: 100 }),
      );
      expect(result.attendance.meta).toEqual({
        page: 2,
        limit: 100,
        total: 250,
        totalPages: 3,
      });
      expect(result.attendance.data).toEqual([{ id: 'a1' }]);
    });

    it('exposes only document metadata, never storage keys or URLs', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'emp-1', employeeNumber: 'EMP-1' });
      prisma.attendanceRecord.findMany.mockResolvedValue([]);
      prisma.attendanceRecord.count.mockResolvedValue(0);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.payslip.findMany.mockResolvedValue([]);
      prisma.document.findMany.mockResolvedValue([]);
      prisma.performanceReview.findMany.mockResolvedValue([]);
      prisma.goal.findMany.mockResolvedValue([]);
      prisma.feedback.findMany.mockResolvedValue([]);
      prisma.rosterEntry.findMany.mockResolvedValue([]);

      await service.exportMyData(employeeViewer());

      const select = prisma.document.findMany.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('fileKey');
      expect(select).not.toHaveProperty('fileUrl');
      expect(select).not.toHaveProperty('storageKey');
    });

    it('requires an employee profile on the caller', async () => {
      await expect(
        service.exportMyData(employeeViewer({ employeeId: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
