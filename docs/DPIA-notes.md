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

## Compliance controls & agreements in place

- **Data Processing Agreements (DPAs)**: Signed DPAs incorporating EU Standard Contractual Clauses (SCCs) and the UK International Data Transfer Addendum are executed with US providers (Google Cloud Vertex/Gemini and Groq). Both providers contractually commit to:
  - Zero model training on customer prompt and completion data.
  - Zero persistent retention beyond transient inference execution.
- **DPO Sign-Off Gate**: AI features gated behind formal DPO sign-off. Production enablement requires documented DPO review of prompt templates and data flows.
- **Sampled Redaction Audit**: Heuristic regex/NER redaction (`privacy.util.ts`) is audited bi-weekly. An authorized compliance reviewer inspects a randomized 1% sample of sanitized prompt payloads to verify that names, national insurance numbers, compensation, and sensitive personal data are completely stripped before leaving the EU/UK boundary.
- **Per-User Daily Token Budgets**: Cost control and strict GDPR data minimisation — hard daily token consumption caps limit the maximum data volume exposed per subject.
- **Circuit Breaker Failover**: Enforces provider isolation and rate throttling; keys stored exclusively via sealed cloud secrets.

## Third-Party Security Dependencies: Fail-Open vs Fail-Closed Trade-Offs

| Dependency | Mechanism | Failure Mode | Rationale & Residual Risk Mitigation |
|------------|-----------|--------------|--------------------------------------|
| **Have I Been Pwned (HIBP)** | k-anonymity range API (SHA-1 prefix) | **Fail-Open** (graceful offline fallback) | **Availability priority**: Third-party Cloudflare/HIBP network outages must not block legitimate employee registration, onboarding, or urgent password resets. *Mitigation:* Strict 12-character minimum, character class requirements, and Argon2id key derivation remain strictly enforced locally. |
| **MFA Replay Guard** | Redis `SET ... NX EX` single-use challenge & TOTP step claim | **Fail-Closed** (`REDIS_REPLAY_FAIL_CLOSED=true`) | **Integrity priority**: Redis loss rejects authentication attempts on sensitive MFA routes, emitting high-visibility `[ALERT]` logs to prevent replay of captured TOTP codes or challenge tokens. |
| **API Throttler** | Redis distributed rate limiting | **Fail-Open** with audit alert | **Service availability priority**: Redis blip preserves request throughput while triggering ops notification. |

## Technical controls already in place

- PII redaction before provider calls (widened field set: names, salaries, NI/SSN, emails, phone numbers).
- Model allowlist in config; per-request timeout (`AI_TIMEOUT_MS`).
- Circuit breaker with half-open recovery (no retry storms).
- Structured AI audit logs with retention purge + dry-run mode.
- Provider API keys via secrets (never in code/logs).

## Residual risks recorded in the DPIA

1. Prompt-injection → cross-user data disclosure (Phase 3 grounded mode; mitigated by DB-level RBAC/PBAC scoping before prompt assembly).
2. Provider-side transient processing of redacted-but-contextual prompts (mitigated by executed DPAs and zero-retention terms).
3. Re-identification from quasi-identifiers (mitigated by ongoing sampled redaction audits).
4. Model version drift changing redaction/formatting behaviour.

---

# Part II: Field Reporting — Mobile Photo & Geolocation Capture DPIA

> STATUS: Working DPIA notes for mobile field reporting, device EXIF retention, and location capture.

## 1. Scope & Personal Data Categories

Employees working on-site or off-site capture photographs and upload technical documentation. The module captures:
1. **Full-resolution device photos**: Includes embedded EXIF metadata (camera model, lens serial, capture timestamp, camera orientation, and optional GPS coordinates).
2. **Device Geolocation (GPS)**: Precise latitude, longitude, and accuracy radius captured via the HTML5 Geolocation API or phone camera sensor.
3. **Field Observations & Incident Notes**: Free-text descriptions and optional incident timestamps.
4. **Author & Reviewer IDs**: Linked to the employee identity and hierarchical reporting chain.

## 2. Lawful Basis & Consent Controls

- **Lawful Basis (Core Work Reports)**: Article 6(1)(b) (Performance of contract) and Article 6(1)(f) (Legitimate interests of the employer for safety, site compliance, and incident logging).
- **Explicit Consent for GPS Tracking**: Article 6(1)(a). GPS location capture is strictly **opt-in** with a dedicated checkbox on the capture form (`gpsConsent: true/false`). Employees may submit reports without enabling geolocation.
- **Privacy Notice at Capture Point**: The mobile interface explicitly informs the user that location coordinates are recorded for incident verification and will be automatically stripped from resized derivatives.

## 3. Data Minimisation & Technical Mitigations

1. **Original vs Resized Separation**:
   - **Originals**: Retained bit-exact at rest in private S3/MinIO buckets with chunked AES-256-GCM envelope encryption. Download access is strictly role-gated (restricted to HR, administrators, and authorized managers with explicit `FIELD_REPORT:DOWNLOAD_ORIGINAL` permission).
   - **Resized & Web Preview Derivatives**: Processed through `sharp` with libvips. All EXIF metadata, GPS IFD tags, maker notes, and device serial numbers are **100% stripped** (`withMetadata({ exif: {} })` omitted). Routine manager reviews and team views consume sanitized derivatives only.
2. **Malware & Anti-Bomb Hardening**:
   - ClamAV fail-closed scanning before any derivative is generated or served.
   - Decompression bomb protection: max 100 megapixels (`limitInputPixels: 100_000_000`) and 16,384px dimension bounds.
3. **Retention & GDPR Erasure Integration**:
   - Field reports are tied to the Employee record via `onDelete: Restrict`.
   - On GDPR erasure requests (`gdpr.service.ts`), employee associations are anonymised; photos are retained or purged per organization retention schedule with dry-run protection (`GDPR_RETENTION_SIGNED_OFF`).
   - S3 staging multipart uploads expire after 24 hours via MinIO/S3 bucket lifecycle rules.

