import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import {
  IAiProvider,
  AiGenerateOptions,
  AiProviderResult,
  AiProviderHealth,
} from './ai-provider.interface';
import { loadAiConfig } from '../config/ai.config';

@Injectable()
export class GroqProvider implements IAiProvider {
  readonly name = 'groq';
  readonly defaultModel = 'llama-3.3-70b-versatile';
  readonly contextWindow = 128000; // 128k tokens

  private readonly logger = new Logger(GroqProvider.name);
  private readonly client: Groq;
  private readonly config = loadAiConfig();

  constructor() {
    this.client = new Groq({
      apiKey: this.config.groqApiKey,
    });
  }

  async generate(prompt: string, options?: AiGenerateOptions): Promise<AiProviderResult> {
    const modelName = options?.model || this.config.groqModel || this.defaultModel;
    const timeoutMs = options?.timeoutMs || this.config.timeoutMs || 30000;
    const startTime = Date.now();

    // systemInstruction is now forwarded as a `system` message (previously
    // accepted by the API but silently dropped).
    const messages: Array<{ role: 'system' | 'user'; content: string }> = options?.systemInstruction
      ? [
          { role: 'system', content: options.systemInstruction },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];

    try {
      let completion: any;
      try {
        completion = await this.client.chat.completions.create(
          {
            model: modelName,
            messages,
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens ?? 2048,
          },
          { timeout: timeoutMs },
        );
      } catch (err: any) {
        if (err.message && err.message.includes('404') && modelName !== 'openai/gpt-oss-120b') {
          this.logger.warn(`Groq model ${modelName} returned 404. Falling back to openai/gpt-oss-120b...`);
          completion = await this.client.chat.completions.create(
            {
              model: 'openai/gpt-oss-120b',
              messages,
              temperature: options?.temperature ?? 0.7,
              max_tokens: options?.maxTokens ?? 2048,
            },
            { timeout: timeoutMs },
          );
        } else {
          throw err;
        }
      }

      const latencyMs = Date.now() - startTime;
      const text = completion.choices[0]?.message?.content || '';

      if (!text || text.trim().length === 0) {
        throw new Error('Groq returned empty response payload.');
      }

      return {
        content: text,
        provider: this.name,
        model: completion.model || modelName,
        latencyMs,
        usage: {
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
          totalTokens: completion.usage?.total_tokens,
        },
        rawResponse: completion,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      this.logger.warn(`Groq generation failure [${latencyMs}ms]: ${err.message}`);
      throw err;
    }
  }

  async healthCheck(): Promise<AiProviderHealth> {
    const startTime = Date.now();
    try {
      const models = await this.client.models.list();
      const latencyMs = Date.now() - startTime;

      return {
        provider: this.name,
        status: models.data && models.data.length > 0 ? 'healthy' : 'degraded',
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
