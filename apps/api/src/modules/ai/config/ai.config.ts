export interface AiConfiguration {
  geminiApiKey: string;
  groqApiKey: string;
  primaryProvider: 'gemini' | 'groq';
  secondaryProvider: 'gemini' | 'groq';
  geminiModel: string;
  groqModel: string;
  timeoutMs: number;
  circuitFailureThreshold: number;
  circuitRecoveryWindowMs: number;
  circuitHalfOpenLimit: number;
  /**
   * Model allowlist (Phase 1 hardening): only these model ids may be used,
   * whether requested explicitly or as a provider default. From
   * AI_MODEL_ALLOWLIST (comma-separated); defaults to the two configured
   * provider models. Unknown models are rejected with 400 before any
   * provider call.
   */
  modelAllowlist: string[];
  /**
   * Per-user daily budget (Phase 1 hardening): max AI generate requests per
   * user per UTC day. From AI_DAILY_BUDGET_PER_USER (default 100).
   * Assumption: request-count budget, not token budget — auditable from
   * AIRequestLog without provider usage reconciliation. Exceeding it returns
   * 429. Lower for cost control once usage data exists.
   */
  dailyBudgetPerUser: number;
}

export const loadAiConfig = (): AiConfiguration => {
  const geminiApiKey =
    process.env.AI_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    '';

  const groqApiKey =
    process.env.AI_GROQ_API_KEY ||
    process.env.GROQ_API_KEY ||
    '';

  return {
    geminiApiKey,
    groqApiKey,
    primaryProvider: (process.env.AI_PRIMARY_PROVIDER as any) || 'gemini',
    secondaryProvider: (process.env.AI_SECONDARY_PROVIDER as any) || 'groq',
    geminiModel: process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash',
    groqModel: process.env.AI_GROQ_MODEL || 'llama-3.3-70b-versatile',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '30000', 10),
    circuitFailureThreshold: parseInt(process.env.AI_CIRCUIT_FAILURE_THRESHOLD || '5', 10),
    circuitRecoveryWindowMs: parseInt(process.env.AI_CIRCUIT_RECOVERY_WINDOW_MS || '30000', 10),
    circuitHalfOpenLimit: parseInt(process.env.AI_CIRCUIT_HALF_OPEN_LIMIT || '2', 10),
    modelAllowlist: parseAllowlist(
      process.env.AI_MODEL_ALLOWLIST,
      process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash',
      process.env.AI_GROQ_MODEL || 'llama-3.3-70b-versatile',
    ),
    dailyBudgetPerUser: parseInt(process.env.AI_DAILY_BUDGET_PER_USER || '100', 10),
  };
};

function parseAllowlist(raw: string | undefined, ...defaults: string[]): string[] {
  const fromEnv = (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = fromEnv.length > 0 ? fromEnv : defaults;
  // The configured provider defaults must always be usable.
  for (const d of defaults) {
    if (!list.includes(d)) list.push(d);
  }
  return list;
}
