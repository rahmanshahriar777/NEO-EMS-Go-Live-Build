import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AIProviderFactory } from '../providers/ai-provider.factory';
import { AiGenerateOptions, AiProviderResult } from '../providers/ai-provider.interface';
// Go-live hardening: the orchestrator routes its failover loop through the
// SHARED generateWithFailoverAsync (packages/shared/src/ai/failover.ts) —
// the single implementation also used by async consumers — and breaker
// state is Redis-backed (shared across replicas) via ResilientBreakerStore,
// which degrades to per-process memory when Redis is unreachable.
import {
  AllProvidersFailedError,
  AiProviderInvoker,
  AsyncFailoverContext,
  CircuitBreakerConfig,
  RedisEvalClient,
  generateWithFailoverAsync,
} from '@ems/shared';
import { ResilientBreakerStore } from './resilient-breaker-store';
import { RedisService } from '../../../core/redis/redis.service';
import { LatencyTracker } from './latency-tracker';
import { AiAuditService } from '../audit/ai-audit.service';
import { AiResponseDto, AiErrorProviderAttempt } from '../dto/ai-response.dto';
import { AiHealthResponseDto, ProviderHealthDto } from '../dto/ai-health.dto';
import { loadAiConfig } from '../config/ai.config';
import { redactPii, excerpt, sha256Hex } from '../privacy.util';
import { PrismaService } from '../../../core/prisma/prisma.service';

@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);
  private readonly config = loadAiConfig();

  private readonly breakerStore: ResilientBreakerStore;
  private readonly latencyTrackers: Map<string, LatencyTracker> = new Map();

  constructor(
    private readonly providerFactory: AIProviderFactory,
    private readonly auditService: AiAuditService,
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {
    // Breaker state: Redis-backed (shared across replicas), degrading to
    // per-process memory when Redis is unreachable. The API's RedisService
    // is global, so no module wiring change is needed.
    const breakerConfig: CircuitBreakerConfig = {
      failureThreshold: this.config.circuitFailureThreshold,
      recoveryWindowMs: this.config.circuitRecoveryWindowMs,
      halfOpenLimit: this.config.circuitHalfOpenLimit,
    };
    const evalClient: RedisEvalClient = {
      eval: (script, numKeys, ...args) => {
        const client = this.redisService.getClient();
        if (!client) {
          return Promise.reject(new Error('Redis client not ready'));
        }
        return (client as any).eval(script, numKeys, ...args) as Promise<unknown>;
      },
    };
    this.breakerStore = new ResilientBreakerStore(evalClient, breakerConfig, this.logger);

    // Latency trackers stay per-process: they feed the health dashboard's
    // p50/p95/error-rate and are observability, not correctness.
    for (const provider of this.providerFactory.getAllProviders()) {
      this.latencyTrackers.set(provider.name, new LatencyTracker());
    }
  }

  /**
   * Executes AI generation with resilient circuit breaker checks and automatic failover.
   */
  async generate(
    prompt: string,
    options?: AiGenerateOptions,
    actor?: { id?: string; email?: string },
  ): Promise<AiResponseDto> {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Phase 1 hardening (1): model allowlist. The effective model (explicit
    // or provider default) must be allowlisted BEFORE any provider call.
    const primaryProvider = this.providerFactory.getPrimary();
    const effectiveModel = options?.model || primaryProvider.defaultModel;
    if (!this.config.modelAllowlist.includes(effectiveModel)) {
      throw new BadRequestException(
        `Model '${effectiveModel}' is not on the AI allowlist. ` +
          `Allowed: ${this.config.modelAllowlist.join(', ')}`,
      );
    }

    // Phase 1 hardening (2): per-user daily budget (request count per UTC
    // day, from AIRequestLog). 429 when exhausted — fail-closed on spend.
    if (actor?.id) {
      await this.enforceDailyBudget(actor.id);
    }

    // Privacy: redact PII BEFORE any provider call and BEFORE audit
    // persistence. Providers and logs only ever see the redacted prompt; the
    // full original is hashed (not stored) for correlation. The caller's own
    // name is redacted too (looked up from their employee profile; fail-open
    // to pattern-only redaction when the lookup fails).
    const redactedPrompt = redactPii(prompt, { names: await this.actorNames(actor?.id) });
    const promptHash = sha256Hex(prompt);

    // systemInstruction is forwarded to providers (see AiGenerateOptions).
    const providerOptions: AiGenerateOptions | undefined = options
      ? { ...options }
      : undefined;

    const secondaryProvider = this.providerFactory.getSecondary();

    // DEDUPE (go-live hardening): the provider failover loop is the shared
    // generateWithFailoverAsync — one implementation for the API's sync path
    // and any async consumer, so breaker behaviour can never drift. The
    // API's IAiProvider is adapted to the shared invoker contract; the
    // systemInstruction (absent from the shared options type) is forwarded
    // via the closure.
    const invokers: AiProviderInvoker[] = [primaryProvider, secondaryProvider].map(
      (provider) => ({
        name: provider.name,
        defaultModel: provider.defaultModel,
        generate: (prompt: string, options?: AiGenerateOptions) =>
          provider.generate(prompt, {
            ...(options ?? {}),
            systemInstruction: providerOptions?.systemInstruction,
          }),
      }),
    );
    const failoverCtx: AsyncFailoverContext = {
      providers: invokers,
      store: this.breakerStore,
      logger: {
        log: (message: string) => this.logger.log(`[${requestId}] ${message}`),
        warn: (message: string) => this.logger.warn(`[${requestId}] ${message}`),
        error: (message: string) => this.logger.error(`[${requestId}] ${message}`),
      },
    };

    const overallStart = Date.now();
    let failoverResult;
    try {
      failoverResult = await generateWithFailoverAsync(
        redactedPrompt,
        providerOptions,
        failoverCtx,
      );
    } catch (err: any) {
      // Complete outage (primary and secondary failed / circuits open).
      const attempts: AiErrorProviderAttempt[] =
        err instanceof AllProvidersFailedError ? err.attempts : [];
      const totalLatencyMs = Date.now() - overallStart;
      for (const attempt of attempts) {
        this.latencyTrackers.get(attempt.provider)?.recordLatency(attempt.latencyMs, false, attempt.error);
      }

      const outageMessage = 'All configured AI providers are currently unavailable or in open circuit state.';
      this.logger.error(`[${requestId}] ${outageMessage} Attempts: ${JSON.stringify(attempts)}`);

      // Log outage event to audit database (redacted excerpt + hash only)
      await this.auditService.recordLog({
        requestId,
        userId: actor?.id,
        actorEmail: actor?.email,
        provider: 'NONE',
        model: options?.model || 'unknown',
        promptExcerpt: excerpt(redactedPrompt),
        promptHash,
        latencyMs: totalLatencyMs,
        succeeded: false,
        error: outageMessage,
        metadata: { attempts },
      });

      throw new ServiceUnavailableException({
        statusCode: 503,
        message: outageMessage,
        errorCode: 'AI_OUTAGE_ALL_PROVIDERS_FAILED',
        attempts,
        retryAfterSeconds: 30,
        timestamp: new Date().toISOString(),
      });
    }

    const totalLatencyMs = Date.now() - overallStart;
    const successfulResult: AiProviderResult = failoverResult;
    const { failoverUsed, failoverReason, attempts } = failoverResult;

    // Latency observability (per-process): failed attempts feed their
    // provider's tracker; the winner records the overall latency.
    for (const attempt of attempts) {
      this.latencyTrackers.get(attempt.provider)?.recordLatency(attempt.latencyMs, false, attempt.error);
    }
    this.latencyTrackers.get(successfulResult.provider)?.recordLatency(totalLatencyMs, true);

    // 3. Persist Token-Level Audit Log to PostgreSQL (redacted excerpt + hashes only).
    // The response excerpt is redacted too — model output can echo PII.
    const redactedResponseExcerpt = excerpt(redactPii(successfulResult.content));
    await this.auditService.recordLog({
      requestId,
      userId: actor?.id,
      actorEmail: actor?.email,
      provider: successfulResult.provider,
      model: successfulResult.model,
      promptExcerpt: excerpt(redactedPrompt),
      promptHash,
      responseExcerpt: redactedResponseExcerpt,
      responseHash: sha256Hex(successfulResult.content),
      promptTokens: successfulResult.usage?.promptTokens,
      completionTokens: successfulResult.usage?.completionTokens,
      totalTokens: successfulResult.usage?.totalTokens,
      latencyMs: totalLatencyMs,
      succeeded: true,
      metadata: {
        failoverUsed,
        failoverReason,
        attempts: attempts.length > 0 ? attempts : undefined,
      },
    });

    return {
      content: successfulResult.content,
      provider: successfulResult.provider as 'gemini' | 'groq',
      model: successfulResult.model,
      latencyMs: totalLatencyMs,
      failoverUsed,
      failoverReason,
      usage: successfulResult.usage,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Per-user daily budget (Phase 1 hardening). Counts today's AIRequestLog
   * rows for the user (UTC day); throws 429 when the budget is exhausted.
   * Request-count budget (not token budget) — auditable without provider
   * usage reconciliation. Assumption: AI_DAILY_BUDGET_PER_USER, default 100.
   */
  private async enforceDailyBudget(userId: string): Promise<void> {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const used = await this.prisma.aIRequestLog.count({
      where: { userId, createdAt: { gte: startOfDay } },
    });
    if (used >= this.config.dailyBudgetPerUser) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `AI daily budget exhausted (${used}/${this.config.dailyBudgetPerUser} requests today)`,
          errorCode: 'AI_DAILY_BUDGET_EXCEEDED',
          retryAfterSeconds: Math.ceil((startOfDay.getTime() + 86400_000 - now.getTime()) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The actor's own names for redaction. Fail-open: on any lookup failure
   * returns [] and pattern-only redaction still applies.
   */
  private async actorNames(userId?: string): Promise<string[]> {
    if (!userId) return [];
    try {
      const employee = await this.prisma.employee.findFirst({
        where: { userId, deletedAt: null },
        select: { firstName: true, lastName: true },
      });
      return [employee?.firstName, employee?.lastName].filter((n): n is string => !!n);
    } catch (e: any) {
      this.logger.warn(`actorNames lookup failed (fail-open): ${e.message}`);
      return [];
    }
  }

  /**
   * Health and observability reporting for admin status dashboards.
   *
   * Breaker state comes from the shared store (Redis-backed across
   * replicas); latency stats stay per-process.
   */
  async getHealthStatus(): Promise<AiHealthResponseDto> {
    const providersReport: Record<string, ProviderHealthDto> = {};
    let hasUnhealthy = false;
    let allUnhealthy = true;

    for (const provider of this.providerFactory.getAllProviders()) {
      const circuitSnapshot = await this.breakerStore.getBreaker(provider.name).getSnapshot();
      const tracker = this.latencyTrackers.get(provider.name)!;

      const p50 = tracker.getP50();
      const p95 = tracker.getP95();
      const errorRate = tracker.getErrorRate();

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (circuitSnapshot.state === 'OPEN') {
        status = 'unhealthy';
        hasUnhealthy = true;
      } else if (circuitSnapshot.state === 'HALF_OPEN' || errorRate > 0.1 || p95 > 10000) {
        status = 'degraded';
        hasUnhealthy = true;
        allUnhealthy = false;
      } else {
        allUnhealthy = false;
      }

      providersReport[provider.name] = {
        provider: provider.name,
        status,
        model: provider.defaultModel,
        circuit: circuitSnapshot,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        errorRate,
        lastSuccessfulRequest: tracker.getLastSuccess(),
        lastError: tracker.getLastError(),
        checkedAt: new Date().toISOString(),
      };
    }

    const overallStatus: 'healthy' | 'degraded' | 'unhealthy' = allUnhealthy
      ? 'unhealthy'
      : hasUnhealthy
      ? 'degraded'
      : 'healthy';

    return {
      overallStatus,
      providers: providersReport,
      primaryProvider: this.config.primaryProvider,
      secondaryProvider: this.config.secondaryProvider,
      timestamp: new Date().toISOString(),
    };
  }
}
