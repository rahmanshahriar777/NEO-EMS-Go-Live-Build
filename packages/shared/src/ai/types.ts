/**
 * Framework-free AI provider types. Imported by the pure failover core so
 * unit tests never need the vendor SDKs.
 */

export interface AiGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AiProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiProviderResult {
  content: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage?: AiProviderUsage;
}

export interface AiProviderInvoker {
  readonly name: string;
  readonly defaultModel: string;
  generate(prompt: string, options?: AiGenerateOptions): Promise<AiProviderResult>;
}

export const DEFAULT_AI_TIMEOUT_MS = 30_000;

/** Rejects if `promise` does not settle within `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Crude token estimate (~4 chars/token); same heuristic the API used. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
