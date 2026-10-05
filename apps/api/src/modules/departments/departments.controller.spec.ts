/**
 * DepartmentsController + DesignationsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DesignationsController } from '../designations/designations.controller';
import { DesignationsService } from '../designations/designations.service';

describe('DepartmentsController', () => {
  let controller: DepartmentsController;
  let service: any;

  const user: any = { sub: 'hr-1', email: 'hr@ems.local' };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DepartmentsController],
      providers: [{ provide: DepartmentsService, useValue: service }],
    }).compile();

    controller = module.get<DepartmentsController>(DepartmentsController);
  });

  it('findAll forwards the query filters', () => {
    service.findAll.mockReturnValue([]);
    controller.findAll('ent-1', 'name', 'asc');
    expect(service.findAll).toHaveBeenCalledWith({
      entityId: 'ent-1',
      sortBy: 'name',
      sortOrder: 'asc',
    });
  });

  it('findOne forwards the id', () => {
    service.findOne.mockReturnValue({ id: 'd1' });
    controller.findOne('d1');
    expect(service.findOne).toHaveBeenCalledWith('d1');
  });

  it('create forwards dto + actor identity', () => {
    service.create.mockReturnValue({ id: 'd1' });
    const dto: any = { name: 'Engineering' };
    controller.create(dto, user);
    expect(service.create).toHaveBeenCalledWith(dto, 'hr-1', 'hr@ems.local');
  });

  it('update forwards id + dto + actor identity', () => {
    service.update.mockReturnValue({ id: 'd1' });
    const dto: any = { name: 'Eng' };
    controller.update('d1', dto, user);
    expect(service.update).toHaveBeenCalledWith('d1', dto, 'hr-1', 'hr@ems.local');
  });

  it('remove forwards id + actor identity', () => {
    service.remove.mockReturnValue({ id: 'd1' });
    controller.remove('d1', user);
    expect(service.remove).toHaveBeenCalledWith('d1', 'hr-1', 'hr@ems.local');
  });
});

describe('DesignationsController', () => {
  let controller: DesignationsController;
  let service: any;

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DesignationsController],
      providers: [{ provide: DesignationsService, useValue: service }],
    }).compile();

    controller = module.get<DesignationsController>(DesignationsController);
  });

  const user: any = { sub: 'hr-1', email: 'hr@ems.local' };

  it('findAll forwards the query filters', () => {
    service.findAll.mockReturnValue([]);
    controller.findAll('dep-1', 'ent-1', 'title', 'desc');
    expect(service.findAll).toHaveBeenCalledWith({
      departmentId: 'dep-1',
      entityId: 'ent-1',
      sortBy: 'title',
      sortOrder: 'desc',
    });
  });

  it('findOne forwards the id', () => {
    service.findOne.mockReturnValue({ id: 'dg1' });
    controller.findOne('dg1');
    expect(service.findOne).toHaveBeenCalledWith('dg1');
  });

  it('create forwards dto + actor identity', () => {
    service.create.mockReturnValue({ id: 'dg1' });
    const dto: any = { title: 'Engineer' };
    controller.create(dto, user);
    expect(service.create).toHaveBeenCalledWith(dto, 'hr-1', 'hr@ems.local');
  });

  it('update forwards id + dto + actor identity', () => {
    service.update.mockReturnValue({ id: 'dg1' });
    const dto: any = { title: 'Senior Engineer' };
    controller.update('dg1', dto, user);
    expect(service.update).toHaveBeenCalledWith('dg1', dto, 'hr-1', 'hr@ems.local');
  });

  it('remove forwards id + actor identity', () => {
    service.remove.mockReturnValue({ id: 'dg1' });
    controller.remove('dg1', user);
    expect(service.remove).toHaveBeenCalledWith('dg1', 'hr-1', 'hr@ems.local');
  });
});
