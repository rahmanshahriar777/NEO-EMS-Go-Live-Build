import { Test, TestingModule } from '@nestjs/testing';
import { PerformanceService } from './performance.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import {
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ReviewStatus, SystemRole } from '@ems/shared';

describe('PerformanceService — A3/A4/A6', () => {
  let service: PerformanceService;
  let prisma: any;
  let policy: any;

  const viewer = (overrides: Record<string, any> = {}) => ({
    userId: 'user-1',
    employeeId: 'emp-1',
    roles: [SystemRole.EMPLOYEE],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      performanceReview: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
      employee: { findMany: jest.fn(), findUnique: jest.fn() },
      goal: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      $queryRaw: jest.fn(async () => []),
    };
    policy = { can: jest.fn(), filterAllowed: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerformanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AccessPolicyService, useValue: policy },
      ],
    }).compile();
    service = module.get<PerformanceService>(PerformanceService);
  });

  describe('A6 getReviews', () => {
    it('returns [] when the caller has no linked employee (non-HR)', async () => {
      const result = await service.getReviews(viewer({ employeeId: undefined }), undefined, undefined);
      expect(result).toEqual([]);
      expect(prisma.performanceReview.findMany).not.toHaveBeenCalled();
    });

    it('returns self + direct reports for a manager', async () => {
      prisma.employee.findMany.mockResolvedValue([{ id: 'emp-2' }]);
      prisma.performanceReview.findMany.mockResolvedValue([{ id: 'r1' }]);
      const result = await service.getReviews(viewer({ roles: [SystemRole.MANAGER] }), undefined, undefined);
      expect(result).toEqual([{ id: 'r1' }]);
      expect(prisma.performanceReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ employeeId: { in: ['emp-1', 'emp-2'] } }) }),
      );
    });

    it('returns [] for a foreign employeeId the viewer may not see', async () => {
      policy.can.mockResolvedValue(false);
      const result = await service.getReviews(viewer(), 'emp-9', undefined);
      expect(result).toEqual([]);
    });

    it('lets HR filter freely', async () => {
      prisma.performanceReview.findMany.mockResolvedValue([]);
      await service.getReviews(viewer({ roles: [SystemRole.HR_ADMIN], employeeId: undefined }), 'emp-9', undefined);
      expect(prisma.performanceReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ employeeId: 'emp-9' }) }),
      );
    });
  });

  describe('A3 submitManagerReview', () => {
    const dto = { managerRating: 4.5, managerFeedback: 'Great work' };

    it('rejects when the caller is not the assigned reviewer', async () => {
      prisma.performanceReview.findUnique.mockResolvedValue({
        id: 'r1', employeeId: 'emp-2', reviewerId: 'emp-3', status: ReviewStatus.DRAFT,
      });
      await expect(service.submitManagerReview('r1', 'emp-1', dto as any)).rejects.toThrow(ForbiddenException);
    });

    it('rejects self-review', async () => {
      prisma.performanceReview.findUnique.mockResolvedValue({
        id: 'r1', employeeId: 'emp-1', reviewerId: 'emp-1', status: ReviewStatus.DRAFT,
      });
      await expect(service.submitManagerReview('r1', 'emp-1', dto as any)).rejects.toThrow(
        /yourself/i,
      );
    });

    it('refuses to overwrite a COMPLETED review', async () => {
      prisma.performanceReview.findUnique.mockResolvedValue({
        id: 'r1', employeeId: 'emp-2', reviewerId: 'emp-1', status: ReviewStatus.COMPLETED,
      });
      await expect(service.submitManagerReview('r1', 'emp-1', dto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.performanceReview.update).not.toHaveBeenCalled();
    });

    it('accepts the assigned reviewer and completes the review', async () => {
      prisma.performanceReview.findUnique.mockResolvedValue({
        id: 'r1', employeeId: 'emp-2', reviewerId: 'emp-1', status: ReviewStatus.SELF_REVIEW_SUBMITTED,
        selfRating: 4,
      });
      prisma.performanceReview.update.mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
      const result: any = await service.submitManagerReview('r1', 'emp-1', dto as any, viewer({ roles: [SystemRole.MANAGER] }));
      expect(result.status).toBe(ReviewStatus.COMPLETED);
      expect(result.finalScore).toBeCloseTo(4 * 0.4 + 4.5 * 0.6, 2);
    });

    it('allows the line manager when no reviewer was assigned', async () => {
      prisma.performanceReview.findUnique.mockResolvedValue({
        id: 'r1', employeeId: 'emp-2', reviewerId: null, status: ReviewStatus.DRAFT,
      });
      prisma.employee.findUnique.mockResolvedValue({ managerId: 'emp-1' });
      prisma.performanceReview.update.mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }));
      const result: any = await service.submitManagerReview('r1', 'emp-1', dto as any, viewer({ roles: [SystemRole.MANAGER] }));
      expect(result.reviewerId).toBe('emp-1');
    });
  });

  describe('A4 goals', () => {
    it('409s a foreign employeeId outside the viewer\u2019s scope', async () => {
      policy.can.mockResolvedValue(false);
      await expect(service.getGoalsScoped(viewer(), 'emp-9')).rejects.toThrow(ConflictException);
    });

    it('allows a manager to list a direct report\u2019s goals', async () => {
      policy.can.mockResolvedValue(true);
      prisma.goal.findMany.mockResolvedValue([{ id: 'g1' }]);
      const result = await service.getGoalsScoped(viewer({ roles: [SystemRole.MANAGER] }), 'emp-2');
      expect(result).toEqual([{ id: 'g1' }]);
      expect(policy.can).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: 'emp-1' }),
        'emp-2',
        'view',
      );
    });

    it('409s creating a goal for a foreign employee', async () => {
      policy.can.mockResolvedValue(false);
      await expect(
        service.createGoalScoped(viewer({ roles: [SystemRole.MANAGER] }), {
          employeeId: 'emp-9',
          title: 'x',
          targetDate: '2026-12-31',
        } as any),
      ).rejects.toThrow(ConflictException);
      expect(prisma.goal.create).not.toHaveBeenCalled();
    });

    it('lets the owner update their own goal', async () => {
      prisma.goal.findUnique.mockResolvedValue({ id: 'g1', employeeId: 'emp-1', progress: 10, status: 'IN_PROGRESS' });
      prisma.goal.update.mockImplementation(async ({ data }: any) => ({ id: 'g1', ...data }));
      const result: any = await service.updateGoal('g1', 'emp-1', { progress: 50 } as any, viewer());
      expect(result.progress).toBe(50);
    });

    it('404s unknown goals', async () => {
      prisma.goal.findUnique.mockResolvedValue(null);
      await expect(service.updateGoal('nope', 'emp-1', {} as any, viewer())).rejects.toThrow(NotFoundException);
    });
  });
});
