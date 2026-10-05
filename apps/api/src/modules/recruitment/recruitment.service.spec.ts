import { Test, TestingModule } from '@nestjs/testing';
import { RecruitmentService } from './recruitment.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SystemRole } from '@ems/shared';

jest.mock('../../core/prisma/schema-compat.util', () => ({
  tableExists: jest.fn(async () => true),
  pickKnownColumns: jest.fn(async (_p: any, _t: string, d: any) => d),
}));

describe('RecruitmentService', () => {
  let service: RecruitmentService;
  let prisma: any;

  const hr = { userId: 'user-hr', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] };
  const employee = { userId: 'user-1', employeeId: 'emp-1', roles: [SystemRole.EMPLOYEE] };

  beforeEach(async () => {
    prisma = {
      vacancy: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
      candidate: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      offer: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      employee: { create: jest.fn(), aggregate: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      $queryRawUnsafe: jest.fn(async () => []),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecruitmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { createNotification: jest.fn() } },
      ],
    }).compile();
    service = module.get<RecruitmentService>(RecruitmentService);
  });

  it('forbids non-HR from creating vacancies', async () => {
    await expect(
      service.createVacancy({ title: 'Engineer' } as any, employee),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects candidates on a closed vacancy', async () => {
    prisma.vacancy.findUnique.mockResolvedValue({ id: 'v-1', status: 'CLOSED' });
    await expect(
      service.addCandidate(
        { vacancyId: 'v-1', firstName: 'Ada', lastName: 'L', email: 'a@x.io' } as any,
        hr,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.candidate.create).not.toHaveBeenCalled();
  });

  it('adds a candidate at APPLIED stage on an open vacancy', async () => {
    prisma.vacancy.findUnique.mockResolvedValue({ id: 'v-1', status: 'OPEN' });
    prisma.candidate.create.mockImplementation(async ({ data }: any) => ({ id: 'c-1', ...data }));
    const result: any = await service.addCandidate(
      { vacancyId: 'v-1', firstName: 'Ada', lastName: 'L', email: 'a@x.io' } as any,
      hr,
    );
    expect(result.stage).toBe('APPLIED');
  });

  it('refuses to move a closed candidate (HIRED/REJECTED)', async () => {
    prisma.candidate.findUnique.mockResolvedValue({ id: 'c-1', stage: 'HIRED' });
    await expect(
      service.updateCandidateStage('c-1', { stage: 'INTERVIEW' } as any, hr),
    ).rejects.toThrow(BadRequestException);
  });

  it('acceptOffer moves candidate to HIRED and auto-creates an employee', async () => {
    prisma.offer.findUnique.mockResolvedValue({
      id: 'o-1',
      status: 'SENT',
      candidateId: 'c-1',
      candidate: { id: 'c-1', firstName: 'Ada', lastName: 'L', email: 'a@x.io', phone: null },
    });
    prisma.offer.update.mockImplementation(async ({ data }: any) => ({ id: 'o-1', ...data }));
    prisma.candidate.update.mockImplementation(async ({ data }: any) => ({ id: 'c-1', ...data }));
    prisma.employee.create.mockImplementation(async ({ data }: any) => ({
      id: 'emp-new',
      ...data,
    }));

    const result: any = await service.acceptOffer('o-1', hr);

    expect(prisma.offer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
    );
    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stage: 'HIRED' }) }),
    );
    expect(prisma.employee.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: 'Ada',
          lastName: 'L',
          email: 'a@x.io',
          status: 'PENDING',
        }),
      }),
    );
    expect(result.employee.employeeNumber).toMatch(/^EMP-/);
  });

  it('404s unknown offers', async () => {
    prisma.offer.findUnique.mockResolvedValue(null);
    await expect(service.acceptOffer('nope', hr)).rejects.toThrow(NotFoundException);
  });
});
