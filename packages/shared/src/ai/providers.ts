import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import {
  AiGenerateOptions,
  AiProviderInvoker,
  AiProviderResult,
  DEFAULT_AI_TIMEOUT_MS,
  estimateTokens,
  withTimeout,
} from './types.js';

/**
 * SDK-backed AI provider invokers shared by the API orchestrator and the
 * worker's AI processor. Each invoker is a plain object with a `generate`
 * function — no framework coupling, swappable in tests via stubbed invokers.
 *
 * Both invokers enforce a per-request timeout via Promise.race, mirroring the
 * behaviour the API providers already had (default 30s, overridable).
 */

export function createGeminiInvoker(apiKey: string): AiProviderInvoker {
  const name = 'gemini';
  const defaultModel = 'gemini-2.5-flash';
  const client = new GoogleGenerativeAI(apiKey);

  return {
    name,
    defaultModel,
    async generate(prompt: string, options: AiGenerateOptions = {}): Promise<AiProviderResult> {
      const modelName = options.model || defaultModel;
      const timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
      const start = Date.now();

      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 2048,
        },
      });

      const response = await withTimeout(model.generateContent(prompt), timeoutMs, `Gemini(${modelName})`);
      const text = response.response?.text();
      if (!text || text.trim().length === 0) {
        throw new Error('Gemini returned empty or blocked content.');
      }
      return {
        content: text,
        provider: name,
        model: modelName,
        latencyMs: Date.now() - start,
        usage: { promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) },
      };
    },
  };
}

export function createGroqInvoker(apiKey: string): AiProviderInvoker {
  const name = 'groq';
  const defaultModel = 'llama-3.3-70b-versatile';
  const client = new Groq({ apiKey });

  return {
    name,
    defaultModel,
    async generate(prompt: string, options: AiGenerateOptions = {}): Promise<AiProviderResult> {
      const modelName = options.model || defaultModel;
      const timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
      const start = Date.now();

      const completion = await withTimeout(
        client.chat.completions.create(
          {
            model: modelName,
            messages: [{ role: 'user', content: prompt }],
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 2048,
          },
          { timeout: timeoutMs },
        ),
        timeoutMs,
        `Groq(${modelName})`,
      );
      const text = completion.choices[0]?.message?.content || '';
      if (!text || text.trim().length === 0) {
        throw new Error('Groq returned empty content.');
      }
      return {
        content: text,
        provider: name,
        model: modelName,
        latencyMs: Date.now() - start,
        usage: { promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) },
      };
    },
  };
}
