/**
 * RecruitmentController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RecruitmentController } from './recruitment.controller';
import { RecruitmentService } from './recruitment.service';
import { SystemRole } from '@ems/shared';

describe('RecruitmentController', () => {
  let controller: RecruitmentController;
  let service: any;

  const user: any = {
    sub: 'hr-1',
    email: 'hr@ems.local',
    employeeId: 'emp-hr',
    roles: [SystemRole.HR_ADMIN],
  };
  const viewer = { userId: 'hr-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] };

  beforeEach(async () => {
    service = {
      listVacancies: jest.fn(),
      createVacancy: jest.fn(),
      addCandidate: jest.fn(),
      listCandidates: jest.fn(),
      updateCandidateStage: jest.fn(),
      createOffer: jest.fn(),
      acceptOffer: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RecruitmentController],
      providers: [{ provide: RecruitmentService, useValue: service }],
    }).compile();

    controller = module.get<RecruitmentController>(RecruitmentController);
  });

  it('listVacancies forwards the status filter', () => {
    service.listVacancies.mockReturnValue([]);
    controller.listVacancies('OPEN');
    expect(service.listVacancies).toHaveBeenCalledWith('OPEN');
  });

  it('createVacancy forwards dto + viewer', () => {
    service.createVacancy.mockReturnValue({ id: 'v1' });
    const dto: any = { title: 'Backend Engineer' };
    controller.createVacancy(dto, user);
    expect(service.createVacancy).toHaveBeenCalledWith(dto, viewer);
  });

  it('addCandidate forwards dto + viewer', () => {
    service.addCandidate.mockReturnValue({ id: 'c1' });
    const dto: any = { vacancyId: 'v1', name: 'Jane' };
    controller.addCandidate(dto, user);
    expect(service.addCandidate).toHaveBeenCalledWith(dto, viewer);
  });

  it('listCandidates forwards id + stage + viewer', () => {
    service.listCandidates.mockReturnValue([]);
    controller.listCandidates('v1', 'SCREENING', user);
    expect(service.listCandidates).toHaveBeenCalledWith('v1', 'SCREENING', viewer);
  });

  it('updateStage forwards id + dto + viewer', () => {
    service.updateCandidateStage.mockReturnValue({ id: 'c1' });
    const dto: any = { stage: 'INTERVIEW' };
    controller.updateStage('c1', dto, user);
    expect(service.updateCandidateStage).toHaveBeenCalledWith('c1', dto, viewer);
  });

  it('createOffer forwards id + dto + viewer', () => {
    service.createOffer.mockReturnValue({ id: 'o1' });
    const dto: any = { salary: 80000 };
    controller.createOffer('c1', dto, user);
    expect(service.createOffer).toHaveBeenCalledWith('c1', dto, viewer);
  });

  it('acceptOffer forwards id + viewer', () => {
    service.acceptOffer.mockReturnValue({ id: 'o1', status: 'ACCEPTED' });
    controller.acceptOffer('o1', user);
    expect(service.acceptOffer).toHaveBeenCalledWith('o1', viewer);
  });
});
