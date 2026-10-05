/**
 * EmployeesController + DocumentsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { SystemRole, JwtPayload } from '@ems/shared';

const user = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  email: 'hr@ems.local',
  roles: [SystemRole.HR_ADMIN],
  permissions: [],
  employeeId: 'emp-hr',
  ...overrides,
});

describe('EmployeesController', () => {
  let controller: EmployeesController;
  let service: any;

  beforeEach(async () => {
    service = {
      findAllScoped: jest.fn(),
      getMyProfile: jest.fn(),
      updateMyAvatar: jest.fn(),
      findOneScoped: jest.fn(),
      create: jest.fn(),
      updateScoped: jest.fn(),
      remove: jest.fn(),
      getAuditLogs: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmployeesController],
      providers: [{ provide: EmployeesService, useValue: service }],
    }).compile();

    controller = module.get<EmployeesController>(EmployeesController);
  });

  it('findAll builds the viewer from the JWT', async () => {
    service.findAllScoped.mockResolvedValue({ data: { items: [] } });
    const query = { page: 1 } as any;

    await controller.findAll(query, user());

    expect(service.findAllScoped).toHaveBeenCalledWith(
      query,
      { userId: 'user-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] },
    );
  });

  it('getMyProfile passes the caller user id and employee id', async () => {
    service.getMyProfile.mockResolvedValue({ id: 'emp-hr' });

    await controller.getMyProfile(user());

    expect(service.getMyProfile).toHaveBeenCalledWith('user-1', 'emp-hr');
  });

  it('create/update/remove propagate the actor identity', async () => {
    service.create.mockResolvedValue({ id: 'emp-9' });
    service.updateScoped.mockResolvedValue({ id: 'emp-9' });
    service.remove.mockResolvedValue({ id: 'emp-9' });

    await controller.create({ firstName: 'A' } as any, user());
    expect(service.create).toHaveBeenCalledWith({ firstName: 'A' }, 'user-1', 'hr@ems.local');

    // A1: updates go through the object-level policy (self / direct reports /
    // HR) via the scoped service method, not a raw update.
    await controller.update('emp-9', { lastName: 'B' } as any, user());
    expect(service.updateScoped).toHaveBeenCalledWith(
      'emp-9',
      { lastName: 'B' },
      { userId: 'user-1', employeeId: 'emp-hr', roles: [SystemRole.HR_ADMIN] },
    );

    await controller.remove('emp-9', user());
    expect(service.remove).toHaveBeenCalledWith('emp-9', 'user-1', 'hr@ems.local');
  });

  it('getAuditLogs delegates to the service', async () => {
    service.getAuditLogs.mockResolvedValue([]);

    await controller.getAuditLogs('emp-9');

    expect(service.getAuditLogs).toHaveBeenCalledWith('emp-9');
  });
});
