'use client';

import { useState } from 'react';
import { api } from '../lib/api-client';

export interface AiCompletionRequest {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface AiCompletionResponse {
  content: string;
  provider: 'gemini' | 'groq';
  model: string;
  latencyMs: number;
  failoverUsed: boolean;
  failoverReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  requestId: string;
  timestamp: string;
}

export function useAiCompletion() {
  const [data, setData] = useState<AiCompletionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const generate = async (params: AiCompletionRequest) => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.ai.generate(params);
      setData(result);
      return result;
    } catch (err: any) {
      const resolvedError =
        err instanceof Error
          ? err
          : new Error(err?.message || 'Failed to complete AI request');
      setError(resolvedError);
      throw resolvedError;
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setData(null);
    setError(null);
    setLoading(false);
  };

  return {
    generate,
    data,
    loading,
    error,
    reset,
  };
}
