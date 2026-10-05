# NEO EMS — DPIA Notes for AI Features

> STATUS: working notes only — NOT a completed Data Protection Impact
> Assessment. A DPIA must be reviewed and signed off by the Data Protection
> Officer BEFORE AI features are enabled for real employee data in
> production. These notes collect what the DPO will need.

## Scope

The AI assistant (apps/api/src/modules/ai + apps/worker processors) sends
prompts to third-party LLM providers (Google Gemini, Groq) with a
circuit-breaker failover. In Phase 3 the assistant becomes "grounded":
role-scoped retrieval over company policies + the user's own HR records.

## Data flows (as implemented)

1. API receives a prompt → `privacy.util.ts` redacts PII (names, addresses,
   salaries, NI numbers — widened per Phase 1) → provider call.
2. Request/response metadata is written to AI audit logs
   (`ai-audit.service.ts`), retained `AI_LOG_RETENTION_DAYS` (default 90),
   purged by the maintenance worker (`purgeExpiredAiLogs`; dry-run by
   default until the `GDPR_RETENTION_SIGNED_OFF` counsel gate is armed).
3. Failover: if the primary provider errors, the secondary is tried with the
   same redacted payload — both providers are therefore (sub)processors.

## Points the DPO must decide

- **Lawful basis** for sending employee-related prompts to US-based LLM
  providers (consent vs legitimate interests; employee-notice wording).
- **Data processing agreements**: signed DPAs with Google and Groq; data
  residency/retention terms of each provider (do they train on inputs?).
- **Redaction adequacy**: `privacy.util.ts` is heuristic regex/NER — the DPO
  should sample real prompts and confirm residual re-identification risk is
  acceptable. Salaries/NI numbers/names/addresses are in scope; consider
  employee IDs, manager names, health-related leave reasons.
- **Grounded retrieval (Phase 3)**: role-scoped retrieval must be enforced in
  the retrieval layer, not the prompt — a manager must never receive another
  employee's records via prompt injection. Depends on the Phase-1 central
  access policy (`AccessPolicyService`).
- **Retention**: 90-day AI log retention is a documented assumption —
  confirm against company policy and employment-law requirements.
- **Per-user daily budget** (Phase 1): cost control AND data-minimisation —
  confirm the budget values with Finance/DPO.
- **Model allowlist**: only configured models (`AI_GEMINI_MODEL`,
  `AI_GROQ_MODEL`) may be called; the DPO should approve the model list
  (new model versions = re-assessment trigger).
- **Erasure**: AI logs are covered by the GDPR erasure inventory
  (table-by-table); confirm prompt/response bodies are purged, not just
  metadata.

## Technical controls already in place

- PII redaction before provider calls (widened field set).
- Model allowlist in config; per-request timeout (`AI_TIMEOUT_MS`).
- Circuit breaker with half-open recovery (no retry storms).
- Structured AI audit logs with retention purge + dry-run mode.
- Provider API keys via secrets (never in code/logs).

## Residual risks to record in the DPIA

1. Prompt-injection → cross-user data disclosure (Phase 3 grounded mode).
2. Provider-side retention/training on redacted-but-contextual prompts.
3. Re-identification from quasi-identifiers (role + department + dates).
4. Model version drift changing redaction/formatting behaviour.
