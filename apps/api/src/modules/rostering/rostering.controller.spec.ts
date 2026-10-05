/**
 * RosteringController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RosteringController } from './rostering.controller';
import { RosteringService } from './rostering.service';

describe('RosteringController', () => {
  let controller: RosteringController;
  let service: any;

  const user: any = { sub: 'mgr-1', email: 'm@ems.local' };

  beforeEach(async () => {
    service = {
      findAllScoped: jest.fn(),
      findOneScoped: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RosteringController],
      providers: [{ provide: RosteringService, useValue: service }],
    }).compile();

    controller = module.get<RosteringController>(RosteringController);
  });

  it('findAll forwards query + user for scoping', () => {
    service.findAllScoped.mockReturnValue([]);
    const query: any = { from: '2026-10-01' };
    controller.findAll(query, user);
    expect(service.findAllScoped).toHaveBeenCalledWith(query, user);
  });

  it('findOne forwards id + user for ownership scoping', () => {
    service.findOneScoped.mockReturnValue({ id: 'ro1' });
    controller.findOne('ro1', user);
    expect(service.findOneScoped).toHaveBeenCalledWith('ro1', user);
  });

  it('create forwards dto + user', () => {
    service.create.mockReturnValue({ id: 'ro1' });
    const dto: any = { employeeId: 'emp-1', date: '2026-10-06' };
    controller.create(dto, user);
    expect(service.create).toHaveBeenCalledWith(dto, user);
  });

  it('update forwards id + dto + user', () => {
    service.update.mockReturnValue({ id: 'ro1' });
    const dto: any = { shift: 'NIGHT' };
    controller.update('ro1', dto, user);
    expect(service.update).toHaveBeenCalledWith('ro1', dto, user);
  });

  it('remove forwards id + user', () => {
    service.remove.mockReturnValue({ id: 'ro1' });
    controller.remove('ro1', user);
    expect(service.remove).toHaveBeenCalledWith('ro1', user);
  });
});
