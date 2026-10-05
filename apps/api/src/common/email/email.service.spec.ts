import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from './email.service';
import { QueueService } from '../../core/queues/queue.service';
import { EMAIL_TITLES, EmailTemplateName } from './email-templates';

/**
 * Email module tests (B2): the API↔worker template contract and the enqueue
 * behaviour of EmailService. Rendering itself lives in the worker
 * (apps/worker/src/email/templates.ts) and is tested there.
 */
describe('email template contract', () => {
  it('exposes all four required template names', () => {
    const names: EmailTemplateName[] = ['invitation', 'verification', 'password-reset', 'payslip-ready'];

    for (const name of names) {
      expect(EMAIL_TITLES[name]).toBeTruthy();
    }
  });
});

describe('EmailService', () => {
  let service: EmailService;
  let queueService: { enqueueNotification: jest.Mock };

  beforeEach(async () => {
    queueService = { enqueueNotification: jest.fn().mockResolvedValue('job-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  it('enqueues on the notifications queue (channel email) with the worker template contract', async () => {
    const jobId = await service.sendTemplated({
      to: 'new@ems.local',
      userId: 'user-2',
      template: 'verification',
      data: { actionUrl: 'https://app/verify?token=abc', expiresNote: '24 hours' },
      idempotencyKey: 'email-verification:deadbeef',
    });

    expect(jobId).toBe('job-1');
    expect(queueService.enqueueNotification).toHaveBeenCalledWith(
      'user-2',
      'email',
      'verification',
      {
        email: 'new@ems.local',
        title: 'Verify your NEO EMS email address',
        actionUrl: 'https://app/verify?token=abc',
        expiresNote: '24 hours',
      },
      // Fail-loud + correlation propagation: EmailService passes the
      // caller's correlationId through untouched (undefined here), letting
      // QueueService resolve the ambient request ID via AsyncLocalStorage
      // instead of minting a fresh UUID.
      undefined,
      'email-verification:deadbeef',
    );
  });

  it('supports an explicit in-app title override', async () => {
    await service.sendTemplated({
      to: 'new.hire@ems.local',
      userId: 'hr-1',
      template: 'invitation',
      data: { actionUrl: 'https://app/accept?token=abc', role: 'EMPLOYEE', expiresNote: '72 hours' },
      idempotencyKey: 'invitation:deadbeef',
      title: 'Invitation to join NEO EMS (EMPLOYEE)',
    });

    expect(queueService.enqueueNotification).toHaveBeenCalledWith(
      'hr-1',
      'email',
      'invitation',
      expect.objectContaining({
        email: 'new.hire@ems.local',
        title: 'Invitation to join NEO EMS (EMPLOYEE)',
        role: 'EMPLOYEE',
      }),
      // undefined lets QueueService resolve the ambient request correlation.
      undefined,
      'invitation:deadbeef',
    );
  });

  it('throws QueueUnavailableException when the queue is unavailable (fail-loud)', async () => {
    const { QueueUnavailableException } = await import(
      '../../core/queues/queue-unavailable.exception'
    );
    queueService.enqueueNotification.mockRejectedValue(
      new QueueUnavailableException('notifications', 'send-notification', 'job-x'),
    );

    await expect(
      service.sendTemplated({
        to: 'new@ems.local',
        userId: 'user-2',
        template: 'password-reset',
        data: { actionUrl: 'https://app/reset?token=abc', expiresNote: '60 minutes' },
        idempotencyKey: 'password-reset:deadbeef',
      }),
    ).rejects.toBeInstanceOf(QueueUnavailableException);
  });
});
