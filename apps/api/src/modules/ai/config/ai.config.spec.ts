import { loadAiConfig } from './ai.config';

describe('loadAiConfig', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.AI_GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.AI_MODEL_ALLOWLIST;
    delete process.env.AI_GEMINI_MODEL;
    delete process.env.AI_GROQ_MODEL;
    delete process.env.AI_DAILY_BUDGET_PER_USER;
    delete process.env.AI_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('applies safe defaults (current models, 100/day budget)', () => {
    const c = loadAiConfig();
    expect(c.geminiModel).toBe('gemini-2.5-flash');
    expect(c.groqModel).toBe('llama-3.3-70b-versatile');
    expect(c.dailyBudgetPerUser).toBe(100);
    expect(c.timeoutMs).toBe(30000);
    expect(c.modelAllowlist).toContain('gemini-2.5-flash');
    expect(c.modelAllowlist).toContain('llama-3.3-70b-versatile');
  });

  it('reads keys from either the AI_ or legacy env names', () => {
    process.env.GEMINI_API_KEY = 'legacy-gemini';
    process.env.AI_GROQ_API_KEY = 'new-groq';
    const c = loadAiConfig();
    expect(c.geminiApiKey).toBe('legacy-gemini');
    expect(c.groqApiKey).toBe('new-groq');
  });

  it('parses an explicit allowlist but always keeps provider defaults usable', () => {
    process.env.AI_MODEL_ALLOWLIST = 'gemini-2.5-flash, custom-model';
    const c = loadAiConfig();
    expect(c.modelAllowlist).toContain('custom-model');
    expect(c.modelAllowlist).toContain('gemini-2.5-flash');
    expect(c.modelAllowlist).toContain('llama-3.3-70b-versatile');
  });

  it('honours a custom daily budget and timeout', () => {
    process.env.AI_DAILY_BUDGET_PER_USER = '25';
    process.env.AI_TIMEOUT_MS = '5000';
    const c = loadAiConfig();
    expect(c.dailyBudgetPerUser).toBe(25);
    expect(c.timeoutMs).toBe(5000);
  });
});
