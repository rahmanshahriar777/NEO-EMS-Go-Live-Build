/**
 * DocumentsController wiring tests — viewer construction, upload validation,
 * and delegation. Guard behavior is covered by
 * common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SystemRole, JwtPayload } from '@ems/shared';

const user = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'user@ems.local',
  roles: [SystemRole.EMPLOYEE],
  permissions: [],
  employeeId: 'emp-1',
  ...overrides,
});

const viewer = { userId: 'user-1', employeeId: 'emp-1', roles: [SystemRole.EMPLOYEE] };

describe('DocumentsController', () => {
  let controller: DocumentsController;
  let service: any;

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      uploadDocument: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [{ provide: DocumentsService, useValue: service }],
    }).compile();

    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('findAll builds the viewer from the JWT', async () => {
    service.findAll.mockResolvedValue({ data: { items: [] } });
    const query = { page: 1 } as any;

    await controller.findAll(query, user());

    expect(service.findAll).toHaveBeenCalledWith(viewer, query);
  });

  it('findOne delegates with the viewer', async () => {
    service.findOne.mockResolvedValue({ id: 'doc-1' });

    await controller.findOne('doc-1', user());

    expect(service.findOne).toHaveBeenCalledWith('doc-1', viewer);
  });

  it('upload rejects a missing file before reaching the service', () => {
    expect(() =>
      controller.upload(undefined as any, { title: 't' } as any, user()),
    ).toThrow(BadRequestException);
    expect(service.uploadDocument).not.toHaveBeenCalled();
  });

  it('upload passes the file and metadata with the viewer', async () => {
    service.uploadDocument.mockResolvedValue({ id: 'doc-1' });
    const file = { originalname: 'a.pdf', buffer: Buffer.from('x') } as any;

    await controller.upload(file, { title: 'Contract', category: 'HR' } as any, user());

    expect(service.uploadDocument).toHaveBeenCalledWith(
      { title: 'Contract', category: 'HR', employeeId: undefined, file },
      viewer,
    );
  });

  it('remove delegates with the viewer', async () => {
    service.remove.mockResolvedValue({ id: 'doc-1' });

    await controller.remove('doc-1', user());

    expect(service.remove).toHaveBeenCalledWith('doc-1', viewer);
  });
});
