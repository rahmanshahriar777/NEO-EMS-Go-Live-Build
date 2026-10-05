/**
 * DepartmentsService unit tests (mocked Prisma + AuditService).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { DepartmentsService, DEPARTMENT_SORT_FIELDS } from './departments.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';

describe('DepartmentsService', () => {
  let service: DepartmentsService;
  let prisma: any;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = {
      department: {
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
        DepartmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<DepartmentsService>(DepartmentsService);
  });

  describe('findAll', () => {
    it('filters soft-deleted rows and allowlists sortBy', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      await service.findAll({ sortBy: 'name; DROP TABLE', sortOrder: 'desc' } as any);
      const args = prisma.department.findMany.mock.calls[0][0];
      expect(args.where.deletedAt).toBeNull();
      expect(args.orderBy).toEqual({ name: 'desc' });
    });

    it('scopes by entityId when provided', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      await service.findAll({ entityId: 'ent-1' });
      expect(prisma.department.findMany.mock.calls[0][0].where.entityId).toBe('ent-1');
    });

    it('exposes the allowlisted sort fields', () => {
      expect([...DEPARTMENT_SORT_FIELDS]).toEqual(['name', 'code', 'createdAt', 'updatedAt']);
    });
  });

  describe('findOne', () => {
    it('returns the department with relations', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'd1', name: 'Eng' });
      await expect(service.findOne('d1')).resolves.toEqual({ id: 'd1', name: 'Eng' });
    });

    it('throws NotFoundException when missing', async () => {
      prisma.department.findFirst.mockResolvedValue(null);
      await expect(service.findOne('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('upper-cases the code and audits the creation', async () => {
      prisma.department.findUnique.mockResolvedValue(null);
      prisma.department.create.mockResolvedValue({ id: 'd1', code: 'ENG' });

      const res = await service.create(
        { name: 'Engineering', code: 'eng' } as any,
        'hr-1',
        'hr@ems.local',
      );

      expect(prisma.department.create.mock.calls[0][0].data.code).toBe('ENG');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE', entityType: 'DEPARTMENT', entityId: 'd1' }),
      );
      expect(res).toEqual({ id: 'd1', code: 'ENG' });
    });

    it('rejects duplicate codes', async () => {
      prisma.department.findUnique.mockResolvedValue({ id: 'd0', code: 'ENG' });
      await expect(
        service.create({ name: 'X', code: 'eng' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.department.create).not.toHaveBeenCalled();
    });
  });

  describe('update / remove', () => {
    it('update upper-cases a provided code and audits', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'd1', code: 'ENG' });
      prisma.department.update.mockResolvedValue({ id: 'd1', code: 'ENGG' });

      await service.update('d1', { code: 'engg' } as any, 'hr-1', 'hr@ems.local');

      expect(prisma.department.update.mock.calls[0][0].data.code).toBe('ENGG');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE', entityId: 'd1' }),
      );
    });

    it('remove soft-deletes and audits', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 'd1' });
      prisma.department.update.mockResolvedValue({ id: 'd1' });

      const res = await service.remove('d1', 'hr-1', 'hr@ems.local');

      expect(prisma.department.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', entityId: 'd1' }),
      );
      expect(res).toEqual({ message: 'Department deleted successfully' });
    });
  });
});
