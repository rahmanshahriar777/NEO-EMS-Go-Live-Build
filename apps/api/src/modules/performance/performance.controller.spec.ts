/**
 * PerformanceController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { SystemRole } from '@ems/shared';

describe('PerformanceController', () => {
  let controller: PerformanceController;
  let service: any;

  const hrUser: any = {
    sub: 'hr-1',
    email: 'hr@ems.local',
    employeeId: 'emp-hr',
    roles: [SystemRole.HR_ADMIN],
  };

  beforeEach(async () => {
    service = {
      getCycles: jest.fn(),
      createCycle: jest.fn(),
      getReviewForms: jest.fn(),
      createReviewForm: jest.fn(),
      getReviewForm: jest.fn(),
      getReviews: jest.fn(),
      createReview: jest.fn(),
      submitSelfReview: jest.fn(),
      submitManagerReview: jest.fn(),
      getGoalsScoped: jest.fn(),
      createGoalScoped: jest.fn(),
      updateGoal: jest.fn(),
      submitFeedback: jest.fn(),
      getFeedback: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PerformanceController],
      providers: [{ provide: PerformanceService, useValue: service }],
    }).compile();

    controller = module.get<PerformanceController>(PerformanceController);
  });

  it('getCycles delegates', () => {
    service.getCycles.mockReturnValue([]);
    controller.getCycles();
    expect(service.getCycles).toHaveBeenCalled();
  });

  it('createCycle forwards dto + actor identity', () => {
    service.createCycle.mockReturnValue({ id: 'cy1' });
    const dto: any = { name: '2026 H2' };
    controller.createCycle(dto, hrUser);
    expect(service.createCycle).toHaveBeenCalledWith(dto, 'hr-1', 'hr@ems.local');
  });

  it('getReviews builds the viewer and forwards filters', () => {
    service.getReviews.mockReturnValue([]);
    controller.getReviews(hrUser, 'emp-9', 'cy1');
    expect(service.getReviews).toHaveBeenCalledWith(
      { userId: 'hr-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] },
      'emp-9',
      'cy1',
    );
  });

  it('createReview builds the viewer', () => {
    service.createReview.mockReturnValue({ id: 'r1' });
    const dto: any = { employeeId: 'emp-9', cycleId: 'cy1' };
    controller.createReview(dto, hrUser);
    expect(service.createReview).toHaveBeenCalledWith(dto, {
      userId: 'hr-1',
      employeeId: 'emp-hr',
      roles: [SystemRole.HR_ADMIN],
    });
  });

  it('submitSelfReview requires an employee profile', () => {
    expect(() =>
      controller.submitSelfReview('r1', {} as any, { ...hrUser, employeeId: undefined }),
    ).toThrow(ForbiddenException);
    expect(service.submitSelfReview).not.toHaveBeenCalled();
  });

  it('submitSelfReview forwards review id + employee id + dto', () => {
    service.submitSelfReview.mockReturnValue({ id: 'r1' });
    const dto: any = { ratings: [] };
    controller.submitSelfReview('r1', dto, hrUser);
    expect(service.submitSelfReview).toHaveBeenCalledWith('r1', 'emp-hr', dto);
  });

  it('submitManagerReview forwards everything including the viewer', () => {
    service.submitManagerReview.mockReturnValue({ id: 'r1' });
    const dto: any = { rating: 4 };
    controller.submitManagerReview('r1', dto, hrUser);
    expect(service.submitManagerReview).toHaveBeenCalledWith('r1', 'emp-hr', dto, {
      userId: 'hr-1',
      employeeId: 'emp-hr',
      roles: [SystemRole.HR_ADMIN],
    });
  });

  it('goals endpoints delegate with the scoped viewer', () => {
    service.getGoalsScoped.mockReturnValue([]);
    service.createGoalScoped.mockReturnValue({ id: 'g1' });
    service.updateGoal.mockReturnValue({ id: 'g1' });

    controller.getGoals(hrUser, 'emp-9');
    expect(service.getGoalsScoped).toHaveBeenCalledWith(
      { userId: 'hr-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] },
      'emp-9',
    );

    const createDto: any = { title: 'Ship it' };
    controller.createGoal(createDto, hrUser);
    expect(service.createGoalScoped).toHaveBeenCalledWith(
      { userId: 'hr-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] },
      createDto,
    );

    const updateDto: any = { progress: 50 };
    controller.updateGoal('g1', updateDto, hrUser);
    expect(service.updateGoal).toHaveBeenCalledWith('g1', 'emp-hr', updateDto, {
      userId: 'hr-1',
      employeeId: 'emp-hr',
      roles: [SystemRole.HR_ADMIN],
    });
  });

  it('feedback endpoints require an employee profile and delegate', () => {
    service.submitFeedback.mockReturnValue({ id: 'f1' });
    service.getFeedback.mockReturnValue([]);

    const dto: any = { content: 'Great work' };
    controller.submitFeedback(dto, hrUser);
    expect(service.submitFeedback).toHaveBeenCalledWith('emp-hr', dto);

    controller.getFeedback(hrUser);
    expect(service.getFeedback).toHaveBeenCalledWith('emp-hr');
  });

  it('review form endpoints delegate', () => {
    service.getReviewForms.mockReturnValue([]);
    service.createReviewForm.mockReturnValue({ id: 'rf1' });
    service.getReviewForm.mockReturnValue({ id: 'rf1' });

    controller.getReviewForms();
    expect(service.getReviewForms).toHaveBeenCalled();

    const dto: any = { name: 'Standard' };
    controller.createReviewForm(dto, hrUser);
    expect(service.createReviewForm).toHaveBeenCalledWith(dto, 'hr-1', 'hr@ems.local');

    controller.getReviewForm('rf1');
    expect(service.getReviewForm).toHaveBeenCalledWith('rf1');
  });
});
