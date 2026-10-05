import { Injectable } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { GroqProvider } from './groq.provider';
import { IAiProvider } from './ai-provider.interface';
import { loadAiConfig } from '../config/ai.config';

@Injectable()
export class AIProviderFactory {
  private readonly config = loadAiConfig();

  constructor(
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
  ) {}

  getPrimary(): IAiProvider {
    return this.config.primaryProvider === 'groq' ? this.groq : this.gemini;
  }

  getSecondary(): IAiProvider {
    return this.config.secondaryProvider === 'gemini' ? this.gemini : this.groq;
  }

  getProvider(name: string): IAiProvider | undefined {
    if (name.toLowerCase() === 'gemini') return this.gemini;
    if (name.toLowerCase() === 'groq') return this.groq;
    return undefined;
  }

  getAllProviders(): IAiProvider[] {
    return [this.gemini, this.groq];
  }
}
