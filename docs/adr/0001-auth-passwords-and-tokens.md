# ADR-0001 — Authentication: PBKDF2 → Argon2id migration, httpOnly cookies, refresh rotation

Date: 2026-10-05 · Status: accepted — **implemented** (Argon2id hashing with
rehash-on-login is live; `JWT_REFRESH_SECRET` removed — refresh tokens are
opaque, server-side hashed tokens; see DEPLOYMENT.md for the one source of
truth on token-secret names)

## Context

The baseline used PBKDF2-HMAC-SHA512 (100k iterations) for password hashing,
returned JWTs in login/refresh response bodies, and rotated refresh tokens
with the family id taken from the client. The assessment (F-findings +
Phase-1 hardening) requires memory-hard hashing, cookie-only token transport,
and server-side rotation state.

## Decision

1. **Passwords → Argon2id** (`argon2` package, added to `apps/api` deps).
   Existing PBKDF2 hashes keep verifying; on the next successful login the
   password is re-hashed with Argon2id (transparent upgrade, no reset wave).
   Minimum length 12; breached-password screening via HIBP k-anonymity with
   graceful offline fallback (fail-open on network error would lock users
   out; fail-closed on a *known-breached* password).
2. **Tokens in httpOnly, Secure, SameSite cookies only** — login/refresh
   responses no longer carry tokens in the body. The web middleware checks
   cookie presence; the API is the session source of truth.
3. **Refresh rotation**: single conditional DB update (compare-and-set on
   the stored token hash); the family id comes from the STORED record, never
   the client; reuse of a rotated token burns the whole family (compromise
   detection). `REFRESH_TTL` is honoured from config; the unused
   `JWT_REFRESH_SECRET` is removed once opaque refresh tokens land.
4. **CSRF**: Origin/Referer check + double-submit CSRF token on mutations
   (cookie transport needs it; the header alone is not enough).
5. **Login**: password verified FIRST; one generic message for
   locked/deactivated/unverified accounts (no oracle).

## Consequences

- `argon2` is a native module: the api Dockerfile builder carries
  python3/make/g++ (runner stays toolchain-free).
- Argon2id parameters (memory/time/parallelism) are a deployment concern —
  tune for ~500ms per hash on prod hardware; document the values.
- Clients must handle 401 → silent refresh → retry; the web api-client owns this.

## Alternatives considered

- bcrypt: weaker memory-hardness story than Argon2id; rejected per OWASP guidance.
- Keeping PBKDF2 with higher iterations: acceptable but not best-practice for
  new work; the transparent rehash makes migration free.
