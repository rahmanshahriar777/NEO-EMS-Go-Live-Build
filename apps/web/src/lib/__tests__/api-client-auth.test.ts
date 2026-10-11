import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api-client';

const BASE = 'https://api.example.test/api/v1';

function errorResponse(status: number, message = 'Unauthorized') {
  return new Response(JSON.stringify({ error: { message, statusCode: status } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse(body: unknown = {}) {
  return new Response(JSON.stringify({ success: true, data: body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-client authentication & unauthenticated visitor handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
    api.clearSessionExpired();

    // Mock window.location
    delete (window as any).location;
    window.location = {
      pathname: '/invitation-accept',
      search: '?token=test-invite-token',
      href: 'http://localhost:3000/invitation-accept?token=test-invite-token',
    } as any;

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (window as any).location = originalLocation;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
  });

  it('does NOT redirect to /login when /auth/me returns 401 on an unauthenticated visit', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/me')) {
        return errorResponse(401, 'Unauthorized');
      }
      if (url.includes('/auth/refresh')) {
        return errorResponse(401, 'No refresh token');
      }
      return okResponse({});
    });

    // Calling /auth/me should throw ApiError(401) without altering window.location.href
    await expect(api.get('/auth/me')).rejects.toThrow('Unauthorized');
    expect(window.location.href).toBe(
      'http://localhost:3000/invitation-accept?token=test-invite-token',
    );
  });

  it('does NOT redirect to /login when 401 occurs while on /invitation-accept page', async () => {
    window.location.pathname = '/invitation-accept';
    window.location.search = '?token=abc';
    window.location.href = 'http://localhost:3000/invitation-accept?token=abc';

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        return errorResponse(401, 'Invalid refresh');
      }
      return errorResponse(401, 'Unauthorized');
    });

    await expect(api.get('/auth/invitations/verify?token=abc')).rejects.toThrow();
    // window.location.href should not be hijacked to /login
    expect(window.location.href).toBe('http://localhost:3000/invitation-accept?token=abc');
  });

  it('redirects to /login when 401 occurs on a protected route like /dashboard or /employees', async () => {
    window.location.pathname = '/employees';
    window.location.search = '';
    window.location.href = 'http://localhost:3000/employees';

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        return errorResponse(401, 'Refresh failed');
      }
      return errorResponse(401, 'Unauthorized');
    });

    await expect(api.get('/employees')).rejects.toThrow();
    expect(window.location.href).toBe('/login?next=%2Femployees');
  });
});
