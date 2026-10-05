'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api-client';

export interface CircuitState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  failureThreshold: number;
  recoveryWindowMs: number;
  lastStateChange: string | null;
}

export interface ProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  model: string;
  circuit: CircuitState;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
  lastSuccessfulRequest: string | null;
  lastError: string | null;
  checkedAt: string;
}

export interface AiHealthData {
  overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  providers: Record<string, ProviderHealth>;
  primaryProvider: string;
  secondaryProvider: string;
  timestamp: string;
}

export function useAiHealth(pollIntervalMs = 30000) {
  const [data, setData] = useState<AiHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await api.ai.getHealth();
      setData(res);
      setError(null);
    } catch (err: any) {
      setError(err instanceof Error ? err : new Error('Failed to fetch AI health'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    if (pollIntervalMs > 0) {
      const interval = setInterval(fetchHealth, pollIntervalMs);
      return () => clearInterval(interval);
    }
  }, [fetchHealth, pollIntervalMs]);

  return {
    data,
    loading,
    error,
    refetch: fetchHealth,
  };
}
