import { requireApiBaseUrl } from './env';

export interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

/** Paginated list envelope returned by the API for list endpoints. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** Error thrown for failed API requests; carries the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_GET_RETRIES = 2; // initial attempt + 2 retries on GET only
const RETRY_BASE_DELAY_MS = 300;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(signal?: AbortSignal | null): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out after 30s')), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

class ApiClient {
  /**
   * In-flight cookie refresh promise. Concurrent 401s share one refresh.
   * A failed refresh REJECTS every waiter (pending requests never hang).
   */
  private refreshPromise: Promise<void> | null = null;
  /**
   * Once the session is known-dead, fail fast instead of retrying refresh
   * on every request. Cleared on explicit login.
   */
  private sessionExpired = false;

  clearSessionExpired() {
    this.sessionExpired = false;
  }

  private buildUrl(endpoint: string, params?: RequestOptions['params']): string {
    const baseUrl = requireApiBaseUrl();
    let url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') searchParams.append(k, String(v));
      });
      const queryString = searchParams.toString();
      if (queryString) url += `${url.includes('?') ? '&' : '?'}${queryString}`;
    }
    return url;
  }

  private isAuthEndpoint(endpoint: string): boolean {
    return endpoint.includes('/auth/login') || endpoint.includes('/auth/refresh') || endpoint.includes('/auth/register');
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  /**
   * Cookie-based session refresh. The API rotates the `ems_rt` httpOnly
   * cookie and re-issues `ems_at`; no tokens ever touch JavaScript.
   */
  private doRefresh(): Promise<void> {
    if (!this.refreshPromise) {
      const attempt = (async (): Promise<void> => {
        const { signal, cancel } = withTimeout();
        try {
          const res = await fetch(`${requireApiBaseUrl()}/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            // Cookie-based: the API reads the ems_rt httpOnly cookie; no body needed.
            body: JSON.stringify({}),
            signal,
          });
          if (!res.ok) {
            throw new ApiError('Session refresh failed', res.status);
          }
          await res.json().catch(() => ({}));
        } finally {
          cancel();
        }
      })();
      // Clear the slot once settled so a later 401 triggers a fresh attempt.
      // Awaiting the ORIGINAL promise still rejects for every waiter.
      this.refreshPromise = attempt;
      attempt.then(
        () => {
          if (this.refreshPromise === attempt) this.refreshPromise = null;
        },
        () => {
          if (this.refreshPromise === attempt) this.refreshPromise = null;
        },
      );
    }
    return this.refreshPromise;
  }

  private handleSessionExpired(): never {
    this.sessionExpired = true;
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new ApiError('Session expired — please sign in again.', 401);
  }

  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    const { signal, cancel } = withTimeout(init.signal ?? null);
    try {
      // credentials:'include' sends the ems_at/ems_rt httpOnly cookies on every request.
      return await fetch(url, { ...init, credentials: 'include', signal });
    } finally {
      cancel();
    }
  }

  async request<T = any>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    if (this.sessionExpired && !this.isAuthEndpoint(endpoint)) {
      throw new ApiError('Session expired — please sign in again.', 401);
    }

    const url = this.buildUrl(endpoint, options.params);
    const method = (options.method || 'GET').toUpperCase();
    const isGet = method === 'GET';

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    };
    // Only send a JSON content type when there is a body to describe.
    const { params: _params, ...fetchOptions } = options;
    if (fetchOptions.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const init: RequestInit = { ...fetchOptions, method, headers };

    // Bounded retries: GET only, max 2 retries with exponential backoff,
    // on network errors/timeouts and retryable statuses (429 / 5xx).
    let response: Response | null = null;
    let lastError: unknown = null;
    const maxAttempts = isGet ? MAX_GET_RETRIES + 1 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await this.fetchOnce(url, init);
        if (!this.isRetryableStatus(response.status) || attempt === maxAttempts) break;
        await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        response = null;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    if (!response) {
      const message =
        lastError instanceof Error && lastError.name === 'AbortError'
          ? 'Request timed out — the API did not respond within 30 seconds.'
          : 'Network error — could not reach the API.';
      throw new ApiError(message, 0);
    }

    // 401: try one cookie refresh, then retry the original request once.
    // If refresh fails, every pending request REJECTS (no hanging) and the
    // user is sent back to /login.
    if (response.status === 401 && !this.isAuthEndpoint(endpoint)) {
      try {
        await this.doRefresh();
      } catch {
        this.handleSessionExpired();
      }
      response = await this.fetchOnce(url, init);
      if (response.status === 401) {
        this.handleSessionExpired();
      }
    }

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMessage =
        json.error?.message || json.message || `Request failed with status ${response.status}`;
      throw new ApiError(errorMessage, response.status);
    }

    return (json.data !== undefined ? json.data : json) as T;
  }

  get<T = any>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  }

  /**
   * GET a paginated list. Accepts the API's `{items, total, page, limit}`
   * envelope (and tolerates a bare array for endpoints that return one).
   */
  async getPaginated<T = any>(endpoint: string, options?: RequestOptions): Promise<Paginated<T>> {
    const raw = await this.get<any>(endpoint, { ...options, method: 'GET' });
    if (Array.isArray(raw)) {
      const limit = Number(options?.params?.limit) || raw.length || 10;
      return { items: raw, total: raw.length, page: Number(options?.params?.page) || 1, limit };
    }
    if (raw && Array.isArray(raw.items)) {
      // Supports both {items, total, page, limit} and the API's canonical
      // envelope {items, meta:{total, page, limit}} (after .data unwrapping).
      const meta = raw.meta ?? {};
      return {
        items: raw.items,
        total: Number(raw.total ?? meta.total ?? raw.items.length),
        page: Number(raw.page ?? meta.page ?? options?.params?.page ?? 1),
        limit: Number(raw.limit ?? meta.limit ?? options?.params?.limit ?? raw.items.length),
      };
    }
    throw new ApiError(`Unexpected response shape from ${endpoint}: expected a list or {items,total}.`, 0);
  }

  post<T = any>(endpoint: string, body?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  put<T = any>(endpoint: string, body?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  patch<T = any>(endpoint: string, body?: any, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  delete<T = any>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  }

  /**
   * Download a file (e.g. DSAR export) with cookie auth and trigger a
   * browser download. Throws loudly on failure.
   */
  async downloadFile(endpoint: string, filename: string): Promise<void> {
    if (typeof window === 'undefined') {
      throw new ApiError('File downloads are only available in the browser.', 0);
    }
    const url = this.buildUrl(endpoint);
    const { signal, cancel } = withTimeout();
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: '*/*' }, signal });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new ApiError(json.message || `Download failed with status ${res.status}`, res.status);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } finally {
      cancel();
    }
  }

  ai = {
    generate: (data: {
      prompt: string;
      systemInstruction?: string;
      temperature?: number;
      maxTokens?: number;
      model?: string;
    }) =>
      this.post<{
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
      }>('/ai/generate', data),
    getHealth: () => this.get<any>('/ai/health'),
    getLogs: (limit = 20) => this.get<any[]>(`/ai/logs?limit=${limit}`),
  };
}

export const api = new ApiClient();
export default api;
