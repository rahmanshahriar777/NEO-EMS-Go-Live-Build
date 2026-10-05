/**
 * DesignationsService unit tests (mocked Prisma + AuditService).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { DesignationsService } from './designations.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';

describe('DesignationsService', () => {
  let service: DesignationsService;
  let prisma: any;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = {
      designation: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DesignationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<DesignationsService>(DesignationsService);
  });

  it('findAll defaults sort to level desc and filters soft-deleted', async () => {
    prisma.designation.findMany.mockResolvedValue([]);
    await service.findAll({});
    const args = prisma.designation.findMany.mock.calls[0][0];
    expect(args.where.deletedAt).toBeNull();
    expect(args.orderBy).toEqual({ level: 'desc' });
  });

  it('findAll accepts a bare departmentId string (back-compat)', async () => {
    prisma.designation.findMany.mockResolvedValue([]);
    await service.findAll('dep-1');
    expect(prisma.designation.findMany.mock.calls[0][0].where.departmentId).toBe('dep-1');
  });

  it('findAll scopes via the department entity when entityId is given', async () => {
    prisma.designation.findMany.mockResolvedValue([]);
    await service.findAll({ entityId: 'ent-1' });
    expect(prisma.designation.findMany.mock.calls[0][0].where.department).toEqual({
      entityId: 'ent-1',
    });
  });

  it('findOne throws NotFoundException when missing', async () => {
    prisma.designation.findFirst.mockResolvedValue(null);
    await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('create upper-cases the code, defaults level to 1, and audits', async () => {
    prisma.designation.findUnique.mockResolvedValue(null);
    prisma.designation.create.mockResolvedValue({ id: 'dg1', code: 'SE', level: 1 });

    const res = await service.create(
      { title: 'Software Engineer', code: 'se' } as any,
      'hr-1',
      'hr@ems.local',
    );

    const data = prisma.designation.create.mock.calls[0][0].data;
    expect(data.code).toBe('SE');
    expect(data.level).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CREATE', entityType: 'DESIGNATION', entityId: 'dg1' }),
    );
    expect(res).toEqual({ id: 'dg1', code: 'SE', level: 1 });
  });

  it('create rejects duplicate codes', async () => {
    prisma.designation.findUnique.mockResolvedValue({ id: 'dg0' });
    await expect(service.create({ title: 'X', code: 'se' } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.designation.create).not.toHaveBeenCalled();
  });

  it('update upper-cases a provided code and audits with before/after', async () => {
    prisma.designation.findFirst.mockResolvedValue({ id: 'dg1', code: 'SE' });
    prisma.designation.update.mockResolvedValue({ id: 'dg1', code: 'SSE' });

    await service.update('dg1', { code: 'sse' } as any, 'hr-1', 'hr@ems.local');

    expect(prisma.designation.update.mock.calls[0][0].data.code).toBe('SSE');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE', entityId: 'dg1' }),
    );
  });

  it('remove soft-deletes and audits', async () => {
    prisma.designation.findFirst.mockResolvedValue({ id: 'dg1' });
    prisma.designation.update.mockResolvedValue({ id: 'dg1' });

    const res = await service.remove('dg1', 'hr-1', 'hr@ems.local');

    expect(prisma.designation.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DELETE', entityId: 'dg1' }),
    );
    expect(res).toEqual({ message: 'Designation deleted successfully' });
  });
});
