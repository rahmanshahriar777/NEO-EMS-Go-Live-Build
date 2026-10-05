/**
 * UsersController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let service: any;

  const caller: any = { sub: 'admin-1', email: 'a@ems.local', roles: ['SUPER_ADMIN'] };

  beforeEach(async () => {
    service = { listUsers: jest.fn(), updateUser: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('list forwards page/limit/search and spreads the result', async () => {
    service.listUsers.mockResolvedValue({ data: [{ id: 'u1' }], total: 1 });

    const res = await controller.list({ page: 2, limit: 10, search: 'jane' } as any);

    expect(service.listUsers).toHaveBeenCalledWith(2, 10, 'jane');
    expect(res).toEqual({ success: true, data: [{ id: 'u1' }], total: 1 });
  });

  it('update forwards caller identity + target + dto', async () => {
    service.updateUser.mockResolvedValue({ id: 'u9', isActive: false });
    const dto: any = { isActive: false };

    const res = await controller.update('u9', dto, caller);

    expect(service.updateUser).toHaveBeenCalledWith('admin-1', ['SUPER_ADMIN'], 'u9', dto);
    expect(res).toEqual({ success: true, data: { id: 'u9', isActive: false } });
  });
});
