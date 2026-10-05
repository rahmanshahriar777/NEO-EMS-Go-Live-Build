import { Test, TestingModule } from '@nestjs/testing';
import { AiAssistantService } from './ai-assistant.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { AiOrchestratorService } from '../ai/orchestrator/ai-orchestrator.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@ems/shared';

describe('AiAssistantService', () => {
  let service: AiAssistantService;
  let prisma: any;
  let orchestrator: any;
  let policy: any;

  const viewer = (overrides: Record<string, any> = {}) => ({
    userId: 'user-1',
    employeeId: 'emp-1',
    email: 'ada@example.com',
    roles: [SystemRole.EMPLOYEE],
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      document: { findMany: jest.fn() },
      leaveRequest: { findMany: jest.fn(), create: jest.fn() },
      goal: { findMany: jest.fn() },
    };
    orchestrator = { generate: jest.fn(async () => ({ content: 'Cited answer.' })) };
    policy = { can: jest.fn(), filterAllowed: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiAssistantService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn(async () => ({})) } },
        { provide: AccessPolicyService, useValue: policy },
        { provide: AiOrchestratorService, useValue: orchestrator },
      ],
    }).compile();
    service = module.get<AiAssistantService>(AiAssistantService);
  });

  describe('retrieveContext (role scoping)', () => {
    it('only reads org-wide policy documents and the caller\u2019s own records', async () => {
      prisma.document.findMany.mockResolvedValue([
        { id: 'doc-1', title: 'Leave Policy', category: 'POLICY' },
      ]);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.goal.findMany.mockResolvedValue([]);

      const { context, citations } = await service.retrieveContext(viewer(), ['policy', 'leave']);

      // Policy docs: employee-less only — never another employee's documents.
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ employeeId: null }),
        }),
      );
      // Leave requests: strictly the caller's own employeeId.
      expect(prisma.leaveRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employeeId: 'emp-1' } }),
      );
      expect(context).toContain('Leave Policy');
      expect(citations).toContainEqual(
        expect.objectContaining({ kind: 'document', ref: 'doc-1' }),
      );
    });

    it('returns no personal context when the caller has no linked employee', async () => {
      prisma.document.findMany.mockResolvedValue([]);
      const { context } = await service.retrieveContext(viewer({ employeeId: undefined }), []);
      expect(context).not.toContain('Your record');
      expect(prisma.leaveRequest.findMany).not.toHaveBeenCalled();
    });
  });

  describe('ask', () => {
    it('returns the orchestrator answer with citations', async () => {
      prisma.document.findMany.mockResolvedValue([]);
      prisma.leaveRequest.findMany.mockResolvedValue([]);
      prisma.goal.findMany.mockResolvedValue([]);

      const result = await service.ask(viewer(), { question: 'How much leave do I have?' });

      expect(result.answer).toBe('Cited answer.');
      expect(Array.isArray(result.citations)).toBe(true);
      // The prompt is grounded: the system instruction forbids invention.
      const [prompt, opts] = orchestrator.generate.mock.calls[0];
      expect(opts.systemInstruction).toMatch(/ONLY from the context/i);
      expect(prompt).toContain('How much leave do I have?');
    });
  });

  describe('runAction (safe actions)', () => {
    it('rejects unsupported actions', async () => {
      await expect(
        service.runAction(viewer(), { action: 'delete-everything', payload: {} }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
    });

    it('requires startDate/endDate for draft-leave-request', async () => {
      await expect(
        service.runAction(viewer(), { action: 'draft-leave-request', payload: {} }),
      ).rejects.toThrow(BadRequestException);
    });

    it('drafts a leave request owned by the caller', async () => {
      prisma.leaveRequest.create.mockImplementation(async ({ data }: any) => ({
        id: 'lr-1',
        ...data,
      }));

      const result = await service.runAction(viewer(), {
        action: 'draft-leave-request',
        payload: { startDate: '2026-12-01', endDate: '2026-12-03' },
      });

      expect(prisma.leaveRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employeeId: 'emp-1', status: 'DRAFT' }),
        }),
      );
      expect(result.usedAction).toEqual({
        action: 'draft-leave-request',
        result: { id: 'lr-1', status: 'DRAFT' },
      });
      expect(result.answer).toMatch(/nothing has been sent to your manager/i);
    });

    it('requires a linked employee profile', async () => {
      await expect(
        service.runAction(viewer({ employeeId: undefined }), {
          action: 'draft-leave-request',
          payload: { startDate: '2026-12-01', endDate: '2026-12-03' },
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
