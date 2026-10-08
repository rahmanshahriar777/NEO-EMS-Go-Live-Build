/**
 * InvitationsController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

describe('InvitationsController', () => {
  let controller: InvitationsController;
  let service: any;

  const user: any = { sub: 'hr-1', email: 'hr@ems.local' };

  beforeEach(async () => {
    service = {
      createInvitation: jest.fn(),
      listInvitations: jest.fn(),
      revokeInvitation: jest.fn(),
      acceptInvitation: jest.fn(),
      verifyInvitation: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitationsController],
      providers: [{ provide: InvitationsService, useValue: service }],
    }).compile();

    controller = module.get<InvitationsController>(InvitationsController);
  });

  it('create forwards the creator id + dto and wraps the result', async () => {
    service.createInvitation.mockResolvedValue({
      id: 'inv-1',
      email: 'new@ems.local',
      role: 'EMPLOYEE',
    });
    const dto: any = { email: 'new@ems.local', role: 'EMPLOYEE' };

    const res = await controller.create(dto, user);

    expect(service.createInvitation).toHaveBeenCalledWith('hr-1', dto);
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/new@ems\.local/);
    expect(res.data.email).toBe('new@ems.local');
  });

  it('list strips token hashes before returning', async () => {
    service.listInvitations.mockResolvedValue([
      { id: 'inv-1', email: 'a@x', tokenHash: 'secret-hash', role: 'EMPLOYEE' },
    ]);

    const res = await controller.list();

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).not.toHaveProperty('tokenHash');
    expect(res.data[0].email).toBe('a@x');
  });

  it('revoke forwards the id', async () => {
    service.revokeInvitation.mockResolvedValue(undefined);
    const res = await controller.revoke('inv-1');
    expect(service.revokeInvitation).toHaveBeenCalledWith('inv-1');
    expect(res).toEqual({ success: true, message: 'Invitation revoked' });
  });

  it('verify forwards the token to the service', async () => {
    service.verifyInvitation.mockResolvedValue({ valid: true, email: 'new@ems.local' });
    const res = await controller.verify('raw-token');
    expect(service.verifyInvitation).toHaveBeenCalledWith('raw-token');
    expect(res).toEqual({ valid: true, email: 'new@ems.local' });
  });

  it('accept forwards the dto and wraps the result', async () => {
    service.acceptInvitation.mockResolvedValue({ userId: 'user-9', email: 'new@ems.local' });
    const dto: any = { token: 'raw', password: 'Long-Enough-1!' };

    const res = await controller.accept(dto);

    expect(service.acceptInvitation).toHaveBeenCalledWith(dto);
    expect(res.success).toBe(true);
    expect(res.data.userId).toBe('user-9');
  });
});
