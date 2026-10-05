import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { AuditService } from '../../../core/audit/audit.service';
import { AuditAction } from '@ems/shared';

export interface RecordAiAuditLogParams {
  requestId: string;
  userId?: string;
  actorEmail?: string;
  provider: string;
  model: string;
  /**
   * Redacted excerpt of the prompt (PII stripped, truncated). The full prompt
   * is NEVER persisted — only the excerpt plus its SHA-256 hash (see
   * promptHash) for duplicate/correlation analysis without retaining data.
   */
  promptExcerpt: string;
  promptHash: string;
  responseExcerpt?: string;
  responseHash?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  succeeded: boolean;
  error?: string;
  metadata?: any;
}

@Injectable()
export class AiAuditService {
  private readonly logger = new Logger(AiAuditService.name);
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly coreAudit: AuditService,
    private readonly configService: ConfigService,
  ) {
    // Assumption: AI log retention defaults to 90 days (AI_LOG_RETENTION_DAYS);
    // confirm with counsel as part of the retention schedule (review §8).
    this.retentionDays =
      parseInt(this.configService.get<string>('AI_LOG_RETENTION_DAYS') || '', 10) || 90;
  }

  async recordLog(params: RecordAiAuditLogParams): Promise<void> {
    // 1. Persist to dedicated PostgreSQL ai_request_logs table. The prompt /
    // response columns now hold redacted excerpts only; hashes live in metadata.
    try {
      await this.prisma.aIRequestLog.create({
        data: {
          requestId: params.requestId,
          userId: params.userId,
          provider: params.provider,
          model: params.model,
          prompt: params.promptExcerpt,
          response: params.responseExcerpt,
          promptTokens: params.promptTokens,
          completionTokens: params.completionTokens,
          totalTokens: params.totalTokens,
          latencyMs: params.latencyMs,
          succeeded: params.succeeded,
          error: params.error,
          metadata: {
            ...(params.metadata ?? {}),
            promptHash: params.promptHash,
            ...(params.responseHash ? { responseHash: params.responseHash } : {}),
            piiRedacted: true,
          },
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to persist token-level AIRequestLog: ${err.message}`);
    }

    // 2. Dispatch to enterprise compliance AuditService
    try {
      await this.coreAudit.log({
        actorId: params.userId,
        actorEmail: params.actorEmail,
        action: AuditAction.CREATE,
        entityType: 'AI_INFERENCE',
        entityId: params.requestId,
        afterState: {
          provider: params.provider,
          model: params.model,
          promptTokens: params.promptTokens,
          completionTokens: params.completionTokens,
          totalTokens: params.totalTokens,
          latencyMs: params.latencyMs,
          succeeded: params.succeeded,
          failoverUsed: params.metadata?.failoverUsed ?? false,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to dispatch core audit log: ${err.message}`);
    }
  }

  async getRecentLogs(limit = 20) {
    return this.prisma.aIRequestLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Deletes AI request logs older than the retention window
   * (AI_LOG_RETENTION_DAYS, default 90). Intended to be called from a
   * scheduled job (e.g. nightly cron in the worker); kept as a service
   * method so the schedule owner can wire it without touching AI internals.
   */
  async purgeExpiredAiLogs(): Promise<{ deleted: number; retentionDays: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);

    const result = await this.prisma.aIRequestLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    this.logger.log(
      `Purged ${result.count} AI request logs older than ${this.retentionDays} days`,
    );
    return { deleted: result.count, retentionDays: this.retentionDays };
  }
}
