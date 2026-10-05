# ADR-0003 — AI: provider failover, redaction-first, auditability

Date: 2026-10-05 · Status: accepted

## Context

The AI assistant calls third-party LLM providers (Gemini primary, Groq
secondary) with employee-adjacent prompts. Risks: provider outage, PII in
prompts, untraceable usage, unbounded cost, and (Phase 3) prompt-injection
across role boundaries in grounded retrieval.

## Decision

1. **Provider abstraction**: `AiProvider` interface + factory; circuit
   breaker per provider (failure threshold, recovery window, half-open
   limit — all env-configurable); failover tries secondary with the SAME
   redacted payload. One shared circuit-breaker implementation
   (`packages/shared/src/ai`) — the duplicate in the API orchestrator is
   removed (Phase-1 refactoring).
2. **Redaction-first**: `privacy.util.ts` strips names, addresses, salaries,
   NI numbers (widened Phase-1 set) BEFORE any provider call. Redaction is
   heuristic — the DPIA (docs/DPIA-notes.md) must validate residual risk.
3. **Model allowlist**: only `AI_GEMINI_MODEL` / `AI_GROQ_MODEL` may be
   called. The retired default `gemini-1.5-flash` is replaced by
   `gemini-2.5-flash`. New model versions trigger re-assessment.
4. **Auditability**: every request/response metadata logged (ai-audit
   service), retained `AI_LOG_RETENTION_DAYS` (default 90, documented
   assumption), purged by the maintenance worker with dry-run support.
   Per-user daily budget caps cost and data exposure.
5. **Phase-3 grounded mode** depends on the Phase-1 central access policy:
   retrieval scoping is enforced in the retrieval layer, never the prompt.

## Consequences

- Both providers are (sub)processors — DPAs required (see DPIA notes).
- Failover doubles the (sub)processor surface; the audit log records which
  provider served each request.
- Disabling AI is a config change (empty API keys) — the app boots fine
  without providers.

## Alternatives considered

- Self-hosted LLM: rejected for Phase 1-3 (operational cost, GPU); revisit
  if provider DPAs or data-residency requirements block launch.
- Single provider: rejected — HR workflows cannot hard-depend on one
  vendor's availability.
