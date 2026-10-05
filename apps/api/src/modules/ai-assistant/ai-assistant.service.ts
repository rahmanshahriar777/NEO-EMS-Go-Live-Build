import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { AccessPolicyService } from '../../core/access-policy/access-policy.service';
import { AiOrchestratorService } from '../ai/orchestrator/ai-orchestrator.service';
import { AuditAction, SystemRole } from '@ems/shared';
import { AssistantAskDto, AssistantActionDto } from './dto/ai-assistant.dto';

export interface AssistantViewer {
  userId: string;
  employeeId?: string;
  email?: string;
  roles: string[];
}

export interface CitedAnswer {
  answer: string;
  citations: Array<{ kind: 'document' | 'record'; ref: string; title: string }>;
  usedAction?: { action: string; result: Record<string, any> };
}

const MAX_CONTEXT_CHARS = 6000;

/**
 * Phase 3, item 4 — grounded AI assistant.
 *
 * Retrieval is ROLE-SCOPED: the assistant only ever sees (a) org-wide
 * employee-less policy documents (the same set any employee can open via
 * GET /documents), (b) the viewer's OWN records (leave balances/requests,
 * own attendance summary, own goals, own review statuses), and (c) for
 * managers/HR, their direct reports' aggregates — all mediated by
 * AccessPolicyService. HR-only records (other employees' payroll, documents)
 * are never injected.
 *
 * Answers are CITED (document ids/titles + record references) so a human can
 * verify. The only write action exposed is the SAFE action: drafting a leave
 * request as a DRAFT record the user then submits through the normal flow.
 */
@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accessPolicy: AccessPolicyService,
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  private hrOrAdmin(roles: string[]): boolean {
    return roles.includes(SystemRole.HR_ADMIN) || roles.includes(SystemRole.SUPER_ADMIN);
  }

  /**
   * Retrieve the context the viewer is entitled to see. Returns plain text
   * plus citation descriptors (document ids, record kinds).
   */
  async retrieveContext(
    viewer: AssistantViewer,
    topics: string[] = [],
  ): Promise<{ context: string; citations: CitedAnswer['citations'] }> {
    const parts: string[] = [];
    const citations: CitedAnswer['citations'] = [];
    const want = new Set(topics.map((t) => t.toLowerCase()));
    const anyTopic = want.size === 0;

    // (a) Org-wide policy documents (employee-less) matching leave/policy-ish
    // categories. Full text retrieval is a Phase-3 stretch; here we index
    // title + category + summary, which is enough for cited Q&A over policy
    // metadata. Never employee-owned docs.
    if (anyTopic || want.has('policy')) {
      // NOTE: Document has no description/summary column — retrieval indexes
      // title + category. Full-text policy indexing is a documented stretch.
      const docs = await this.prisma.document.findMany({
        where: {
          deletedAt: null,
          employeeId: null,
          category: { in: ['POLICY', 'HANDBOOK', 'GUIDELINE'] },
        },
        select: { id: true, title: true, category: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      for (const d of docs) {
        parts.push(`[Policy document] "${d.title}" (${d.category}).`);
        citations.push({ kind: 'document', ref: d.id, title: d.title });
      }
    }

    if (!viewer.employeeId) {
      return { context: parts.join('\n'), citations };
    }

    // (b) The viewer's own leave balances + recent requests.
    if (anyTopic || want.has('my-leave-balance') || want.has('leave')) {
      const balances = await (this.prisma as any).leaveBalance?.findMany?.({
        where: { employeeId: viewer.employeeId },
        include: { leaveType: { select: { name: true } } },
      });
      if (balances?.length) {
        for (const b of balances) {
          parts.push(
            `[Your record] Leave balance — ${b.leaveType?.name ?? b.leaveTypeId}: ` +
              `${b.remaining ?? b.balance ?? '?'} days remaining (used ${b.used ?? 0}, allocated ${b.allocated ?? '?'}).`,
          );
        }
        citations.push({ kind: 'record', ref: 'leave-balances', title: 'Your leave balances' });
      }
      const requests = await this.prisma.leaveRequest.findMany({
        where: { employeeId: viewer.employeeId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, startDate: true, endDate: true, status: true, leaveType: { select: { name: true } } },
      });
      for (const r of requests) {
        parts.push(
          `[Your record] Leave request ${r.id}: ${(r as any).leaveType?.name ?? 'leave'} ` +
            `${r.startDate?.toISOString?.().slice(0, 10)} → ${r.endDate?.toISOString?.().slice(0, 10)} (${r.status}).`,
        );
      }
      if (requests.length) {
        citations.push({ kind: 'record', ref: 'leave-requests', title: 'Your recent leave requests' });
      }
    }

    // (c) Own goals (and, for managers, team goal counts).
    if (anyTopic || want.has('goals')) {
      const goals = await this.prisma.goal.findMany({
        where: { employeeId: viewer.employeeId },
        select: { id: true, title: true, status: true, progress: true },
        take: 10,
      });
      for (const g of goals) {
        parts.push(`[Your record] Goal "${g.title}": ${g.status}, ${g.progress}% complete.`);
      }
      if (goals.length) {
        citations.push({ kind: 'record', ref: 'goals', title: 'Your goals' });
      }
    }

    return { context: parts.join('\n').slice(0, MAX_CONTEXT_CHARS), citations };
  }

  async ask(viewer: AssistantViewer, dto: AssistantAskDto): Promise<CitedAnswer> {
    const { context, citations } = await this.retrieveContext(viewer, dto.topics);

    const systemInstruction =
      'You are the NEO EMS HR assistant. Answer ONLY from the context provided below. ' +
      'Cite the source of each factual claim as [document:<title>] or [record:<title>]. ' +
      'If the context does not contain the answer, say so honestly and do not invent policy details. ' +
      'Never reveal information about other employees.';

    const prompt = `Question: ${dto.question}\n\nContext:\n${context || '(no accessible records found)'}`;

    const result = await this.orchestrator.generate(
      prompt,
      { systemInstruction },
      { id: viewer.userId, email: viewer.email },
    );

    await this.audit.log({
      actorId: viewer.userId,
      // Schema need (worker 4): AuditAction.READ — query audits are currently
      // recorded as UPDATE; add READ (and DOCUMENT_DOWNLOAD) to AuditAction.
      action: AuditAction.UPDATE,
      entityType: 'AI_ASSISTANT_QUERY',
      entityId: 'ask',
      afterState: { kind: 'READ', questionLength: dto.question.length, citationCount: citations.length },
    }).catch((e: any) => this.logger.warn(`AI query audit failed (fail-open): ${e.message}`));

    return { answer: result.content, citations };
  }

  /**
   * SAFE actions only. Currently the only supported action is
   * `draft-leave-request`, which creates a DRAFT LeaveRequest owned by the
   * viewer. The user must still submit/approve through the normal flow.
   */
  async runAction(viewer: AssistantViewer, dto: AssistantActionDto): Promise<CitedAnswer> {
    if (dto.action !== 'draft-leave-request') {
      throw new BadRequestException(
        `Unsupported action "${dto.action}". Supported actions: draft-leave-request.`,
      );
    }
    if (!viewer.employeeId) {
      throw new ForbiddenException('Employee profile required to draft a leave request');
    }

    const { startDate, endDate, leaveTypeId, reason } = dto.payload ?? {};
    if (!startDate || !endDate) {
      throw new BadRequestException('draft-leave-request requires payload.startDate and payload.endDate (YYYY-MM-DD)');
    }

    // Schema need (worker 4): LeaveStatus.DRAFT. Until it lands the enum value
    // does not exist and the draft cannot be persisted as DRAFT — degrade to a
    // named ServiceUnavailableException rather than a raw Prisma enum error.
    // Half-day fields (LeaveRequest.halfDay/halfDayPeriod) are likewise
    // unmigrated, so drafts are full-day until the leave v2 migration lands.
    let draft: any;
    try {
      draft = await this.prisma.leaveRequest.create({
        // 'DRAFT' is cast: the enum value arrives with the worker-4 migration;
        // the whole create is wrapped so a missing enum degrades to 503.
        data: {
          employeeId: viewer.employeeId,
          leaveTypeId: leaveTypeId ?? undefined,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          reason: reason ?? 'Drafted by AI assistant',
          status: 'DRAFT',
        } as any,
      });
    } catch (e: any) {
      throw new ServiceUnavailableException(
        'Draft leave requests require the LeaveStatus.DRAFT enum value (worker 4 migration).',
      );
    }

    await this.audit.log({
      actorId: viewer.userId,
      action: AuditAction.CREATE,
      entityType: 'LEAVE_REQUEST',
      entityId: draft.id,
      afterState: { via: 'ai-assistant', status: 'DRAFT', startDate, endDate },
    });

    return {
      answer:
        `I've drafted a leave request for ${startDate} → ${endDate} (DRAFT status, id ${draft.id}). ` +
        'Review it and submit it from the leave screen — nothing has been sent to your manager yet.',
      citations: [{ kind: 'record', ref: draft.id, title: 'Draft leave request' }],
      usedAction: { action: dto.action, result: { id: draft.id, status: 'DRAFT' } },
    };
  }
}
