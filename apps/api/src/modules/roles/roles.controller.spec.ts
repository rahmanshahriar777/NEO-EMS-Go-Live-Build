/**
 * RolesController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

describe('RolesController', () => {
  let controller: RolesController;
  let service: any;

  beforeEach(async () => {
    service = {
      listPermissions: jest.fn(),
      listRoles: jest.fn(),
      createRole: jest.fn(),
      updateRole: jest.fn(),
      deleteRole: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [{ provide: RolesService, useValue: service }],
    }).compile();

    controller = module.get<RolesController>(RolesController);
  });

  it('listPermissions delegates', async () => {
    service.listPermissions.mockResolvedValue([{ subject: 'leave', action: 'approve' }]);
    await expect(controller.listPermissions()).resolves.toEqual({
      success: true,
      data: [{ subject: 'leave', action: 'approve' }],
    });
  });

  it('list delegates to listRoles', async () => {
    service.listRoles.mockResolvedValue([{ name: 'EMPLOYEE' }]);
    await expect(controller.list()).resolves.toEqual({
      success: true,
      data: [{ name: 'EMPLOYEE' }],
    });
  });

  it('create forwards the dto', async () => {
    service.createRole.mockResolvedValue({ id: 'r1', name: 'X' });
    const dto: any = { name: 'X' };
    const res = await controller.create(dto);
    expect(service.createRole).toHaveBeenCalledWith(dto);
    expect(res).toEqual({ success: true, data: { id: 'r1', name: 'X' } });
  });

  it('update forwards id + dto', async () => {
    service.updateRole.mockResolvedValue({ id: 'r1', name: 'Y' });
    const dto: any = { name: 'Y' };
    const res = await controller.update('r1', dto);
    expect(service.updateRole).toHaveBeenCalledWith('r1', dto);
    expect(res).toEqual({ success: true, data: { id: 'r1', name: 'Y' } });
  });

  it('remove forwards the id', async () => {
    service.deleteRole.mockResolvedValue(undefined);
    const res = await controller.remove('r1');
    expect(service.deleteRole).toHaveBeenCalledWith('r1');
    expect(res).toEqual({ success: true, message: 'Role deleted' });
  });
});
