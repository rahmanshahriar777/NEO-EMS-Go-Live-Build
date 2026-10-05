export interface AiGenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * System-level instruction forwarded to the provider (Gemini
   * `systemInstruction` / Groq `system` message). Previously accepted by the
   * API but silently dropped; now actually applied. Documented decision: the
   * parameter is kept and forwarded rather than removed.
   */
  systemInstruction?: string;
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
  rawResponse?: any;
}

export interface AiProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

export interface IAiProvider {
  /**
   * Provider identifier (e.g. 'gemini', 'groq')
   */
  readonly name: string;

  /**
   * Default model utilized by this provider
   */
  readonly defaultModel: string;

  /**
   * Context window size in tokens
   */
  readonly contextWindow: number;

  /**
   * Executes completion request against provider API
   */
  generate(prompt: string, options?: AiGenerateOptions): Promise<AiProviderResult>;

  /**
   * Executes lightweight connectivity and authentication ping
   */
  healthCheck(): Promise<AiProviderHealth>;

  /**
   * Estimates token count for text payload
   */
  estimateTokens(text: string): number;
}

export const AI_PRIMARY_PROVIDER_TOKEN = 'AI_PRIMARY_PROVIDER_TOKEN';
export const AI_SECONDARY_PROVIDER_TOKEN = 'AI_SECONDARY_PROVIDER_TOKEN';
