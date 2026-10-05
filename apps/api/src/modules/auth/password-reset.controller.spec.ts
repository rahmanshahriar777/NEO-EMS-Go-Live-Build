/**
 * PasswordResetController wiring tests.
 * Guard behavior is covered by common/guards/access-matrix.spec.ts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';

describe('PasswordResetController', () => {
  let controller: PasswordResetController;
  let service: any;

  beforeEach(async () => {
    service = { requestPasswordReset: jest.fn(), confirmPasswordReset: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PasswordResetController],
      providers: [{ provide: PasswordResetService, useValue: service }],
    }).compile();

    controller = module.get<PasswordResetController>(PasswordResetController);
  });

  it('request always returns the generic response (no account-existence oracle)', async () => {
    service.requestPasswordReset.mockResolvedValue(undefined);

    const res = await controller.request({ email: 'nobody@ems.local' } as any);

    expect(service.requestPasswordReset).toHaveBeenCalledWith('nobody@ems.local');
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/If an account exists/);
  });

  it('confirm forwards token + new password', async () => {
    service.confirmPasswordReset.mockResolvedValue(undefined);

    const res = await controller.confirm({ token: 'tok', newPassword: 'New-Password-1!' } as any);

    expect(service.confirmPasswordReset).toHaveBeenCalledWith('tok', 'New-Password-1!');
    expect(res.success).toBe(true);
  });
});
