import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, readCsrfCookieValue, csrfTokenForMutation } from '../api-client';

const BASE = 'https://api.example.test/api/v1';

function clearCookies() {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

function okResponse(body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-client CSRF double-submit (x-csrf-token)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
    clearCookies();
    fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearCookies();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  });

  it('sends x-csrf-token on POST mutations, echoing the csrf cookie', async () => {
    document.cookie = 'csrf=tok-abc-123';
    await api.post('/employees', { name: 'Jane' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-abc-123');
  });

  it('sends x-csrf-token on PUT, PATCH and DELETE mutations', async () => {
    document.cookie = 'csrf=tok-xyz';
    await api.put('/employees/1', {});
    await api.patch('/employees/1', {});
    await api.delete('/employees/1');
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-xyz');
    }
  });

  it('does not send x-csrf-token on safe (GET) requests', async () => {
    document.cookie = 'csrf=tok-abc-123';
    await api.get('/employees');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('never overwrites a caller-supplied x-csrf-token header', async () => {
    document.cookie = 'csrf=tok-cookie';
    await api.post('/employees', {}, { headers: { 'X-CSRF-Token': 'tok-explicit' } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('tok-explicit');
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('omits the header when the csrf cookie is absent (e.g. before login)', async () => {
    // No csrf cookie set.
    await api.post('/auth/login', { email: 'a@b.c', password: 'pw' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('includes x-csrf-token on the cookie-refresh POST after a 401', async () => {
    document.cookie = 'csrf=tok-refresh';
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) return okResponse();
      if (String(url).endsWith('/auth/me')) {
        meCalls += 1;
        return meCalls === 1
          ? new Response('{}', { status: 401 })
          : okResponse({ data: { user: { email: 'a@b.c' } } });
      }
      return okResponse();
    });
    await api.get('/auth/me');
    const refreshCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/auth/refresh'),
    );
    expect(refreshCall).toBeDefined();
    const init = refreshCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok-refresh');
  });

  describe('readCsrfCookieValue', () => {
    it('returns null when the cookie is absent', () => {
      expect(readCsrfCookieValue()).toBeNull();
    });

    it('finds the csrf cookie among others', () => {
      document.cookie = 'other=1';
      document.cookie = 'csrf=my-token';
      document.cookie = 'session=abc';
      expect(readCsrfCookieValue()).toBe('my-token');
    });

    it('URI-decodes the cookie value', () => {
      document.cookie = 'csrf=tok%2Fwith%3Dchars';
      expect(readCsrfCookieValue()).toBe('tok/with=chars');
    });

    it('csrfTokenForMutation mirrors the cookie value', () => {
      document.cookie = 'csrf=tok-1';
      expect(csrfTokenForMutation()).toBe('tok-1');
      clearCookies();
      expect(csrfTokenForMutation()).toBeNull();
    });
  });
});
