import { describe, it, expect } from 'vitest';
import { resolveSafeNextPath, DEFAULT_POST_LOGIN_PATH } from '../safe-next';

describe('resolveSafeNextPath (login ?next= redirect)', () => {
  it('accepts a plain in-app path', () => {
    expect(resolveSafeNextPath('/leaves')).toBe('/leaves');
    expect(resolveSafeNextPath('/employees/123?tab=docs')).toBe('/employees/123?tab=docs');
  });

  it('falls back to /dashboard for missing or empty values', () => {
    expect(resolveSafeNextPath(null)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath(undefined)).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('   ')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(DEFAULT_POST_LOGIN_PATH).toBe('/dashboard');
  });

  it('rejects absolute URLs (open-redirect protection)', () => {
    expect(resolveSafeNextPath('https://evil.example/phish')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('http://evil.example')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('javascript:alert(1)')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('rejects protocol-relative and backslash tricks', () => {
    expect(resolveSafeNextPath('//evil.example/login')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('/\\evil.example')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('/leaves\\..\\evil')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('rejects scheme-like segments and API routes', () => {
    expect(resolveSafeNextPath('/foo:bar')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('/api/v1/auth/me')).toBe(DEFAULT_POST_LOGIN_PATH);
    expect(resolveSafeNextPath('/api')).toBe(DEFAULT_POST_LOGIN_PATH);
  });

  it('accepts nested app routes with query strings', () => {
    expect(resolveSafeNextPath('/admin/audit-logs?page=2')).toBe('/admin/audit-logs?page=2');
  });
});
