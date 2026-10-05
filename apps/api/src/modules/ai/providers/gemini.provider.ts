import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  IAiProvider,
  AiGenerateOptions,
  AiProviderResult,
  AiProviderHealth,
} from './ai-provider.interface';
import { loadAiConfig } from '../config/ai.config';

@Injectable()
export class GeminiProvider implements IAiProvider {
  readonly name = 'gemini';
  readonly defaultModel = 'gemini-2.5-flash';
  readonly contextWindow = 1000000; // 1M tokens

  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client: GoogleGenerativeAI;
  private readonly config = loadAiConfig();

  constructor() {
    this.client = new GoogleGenerativeAI(this.config.geminiApiKey);
  }

  async generate(prompt: string, options?: AiGenerateOptions): Promise<AiProviderResult> {
    const modelName = options?.model || this.config.geminiModel || this.defaultModel;
    const timeoutMs = options?.timeoutMs || this.config.timeoutMs || 30000;
    const startTime = Date.now();

    const model = this.client.getGenerativeModel({
      model: modelName,
      // systemInstruction is now forwarded (previously accepted by the API
      // but silently dropped).
      ...(options?.systemInstruction
        ? { systemInstruction: { role: 'system', parts: [{ text: options.systemInstruction }] } }
        : {}),
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 2048,
      },
    });

    // Enforce timeout using Promise.race
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Gemini request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      let response: any;
      try {
        response = await Promise.race([
          model.generateContent(prompt),
          timeoutPromise,
        ]);
      } catch (err: any) {
        if (err.message && err.message.includes('404') && modelName !== 'gemini-flash-latest') {
          this.logger.warn(`Model ${modelName} returned 404. Falling back to alias gemini-flash-latest...`);
          const fallbackModel = this.client.getGenerativeModel({
            model: 'gemini-flash-latest',
            ...(options?.systemInstruction
              ? { systemInstruction: { role: 'system', parts: [{ text: options.systemInstruction }] } }
              : {}),
            generationConfig: {
              temperature: options?.temperature ?? 0.7,
              maxOutputTokens: options?.maxTokens ?? 2048,
            },
          });
          response = await Promise.race([
            fallbackModel.generateContent(prompt),
            timeoutPromise,
          ]);
        } else {
          throw err;
        }
      }

      const latencyMs = Date.now() - startTime;
      const text = response.response?.text();

      if (!text || text.trim().length === 0) {
        throw new Error('Gemini returned empty or blocked content.');
      }

      const promptTokens = this.estimateTokens(prompt);
      const completionTokens = this.estimateTokens(text);

      return {
        content: text,
        provider: this.name,
        model: modelName,
        latencyMs,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        rawResponse: response.response,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      this.logger.warn(`Gemini generation failure [${latencyMs}ms]: ${err.message}`);
      throw err;
    }
  }

  async healthCheck(): Promise<AiProviderHealth> {
    const startTime = Date.now();
    try {
      const model = this.client.getGenerativeModel({
        model: this.defaultModel,
        generationConfig: { maxOutputTokens: 5 },
      });
      const res = await model.generateContent('ping');
      const text = res.response?.text();
      const latencyMs = Date.now() - startTime;

      return {
        provider: this.name,
        status: text ? 'healthy' : 'degraded',
        latencyMs,
        checkedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      return {
        provider: this.name,
        status: 'unhealthy',
        latencyMs,
        message: err.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
