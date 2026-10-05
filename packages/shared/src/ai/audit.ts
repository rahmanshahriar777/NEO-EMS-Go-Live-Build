/**
 * Shared AI audit-write path.
 *
 * Both the API orchestrator and the worker's AI processor persist AI
 * request/response metadata through this helper so the row shape and the
 * required fields can never drift. The helper is DB-agnostic: callers pass
 * the Prisma `aiRequestLog` delegate (or any object with a compatible
 * `create`) so `@ems/shared` does not depend on `@ems/database`.
 */

export interface AiAuditLogEntry {
  requestId: string;
  userId?: string;
  provider: string;
  model: string;
  prompt: string;
  response?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  succeeded: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface AiAuditLogWriter {
  create(args: { data: Record<string, any> }): Promise<unknown>;
}

export async function writeAiAuditLog(writer: AiAuditLogWriter, entry: AiAuditLogEntry): Promise<void> {
  if (!entry.requestId) throw new Error('writeAiAuditLog: requestId is required');
  await writer.create({
    data: {
      requestId: entry.requestId,
      userId: entry.userId ?? null,
      provider: entry.provider,
      model: entry.model,
      prompt: entry.prompt,
      response: entry.response ?? null,
      promptTokens: entry.promptTokens ?? null,
      completionTokens: entry.completionTokens ?? null,
      totalTokens: entry.totalTokens ?? null,
      latencyMs: entry.latencyMs,
      succeeded: entry.succeeded,
      error: entry.error ?? null,
      metadata: entry.metadata ?? undefined,
    },
  });
}
