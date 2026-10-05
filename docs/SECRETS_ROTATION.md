# NEO EMS — Secrets Rotation Runbook (git-history compromise)

> **Threat model:** git history still contains real credentials committed
> before the go-live hardening (demo seeds, past `.env` values, CI secret
> placeholders that were briefly real). **Treat every credential that ever
> appeared in git history as compromised.** This runbook is the one-time
> burn-down plus the ongoing rotation discipline. Mechanical how-to for
> individual secrets lives in [KEY_ROTATION.md](KEY_ROTATION.md) — this
> document is the *what, why, and in what order*.

## 0. Rules of engagement

1. **Rotate before go-live.** Do not point any production system at a
   credential that has ever lived in the repository.
2. **New secrets are born in the secret manager**, never in a shell history
   file, chat log, or ticket. Generate with `openssl rand` and pipe them
   straight into the manager (or use its generator).
3. **Never commit real secrets** — gitleaks runs in CI
   (`.github/workflows/ci.yaml`) and will fail the build. Consider a
   pre-commit gitleaks hook for local work.
4. **Log every rotation** (date, secret name, operator, reason, old-value
   destruction confirmation). Template in §7.

## 1. Rotation inventory — burn down every one of these

| # | Secret | Where it is used | Rotation consequence |
|---|--------|------------------|----------------------|
| 1 | `DATABASE_URL` / `PROD_DATABASE_URL` (managed Postgres password) | API, worker, migrate job | Restart all consumers; a few seconds of failed connections during cutover — plan a maintenance window |
| 2 | `JWT_ACCESS_SECRET` | API (all replicas must switch together) | All access tokens invalidate; clients re-login via refresh flow. Refresh tokens are opaque server-side tokens — they survive a JWT secret rotation |
| 3 | `DOCUMENT_ENCRYPTION_KEY` | Documents module (AES-256-GCM) | **Highest-risk rotation.** See §3 and [KEY_ROTATION.md](KEY_ROTATION.md) §1 |
| 4 | `REDIS_PASSWORD` | API, worker (BullMQ, throttler, circuit-breaker) | Brief queue/rate-limit outage during cutover |
| 5 | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, `S3_*` keys | Documents, avatars, backups | Old presigned URLs stop working; regenerate any embedded links |
| 6 | `SMTP_USER` / `SMTP_PASS` (canonical name — see note) | Worker email sender | Test with a canary email before cutover |
| 7 | `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_MICROSOFT_CLIENT_SECRET` | OAuth flow (disabled by default; rotate when enabling) | Rotate in the IdP console, then update the secret manager |
| 8 | `AI_GEMINI_API_KEY` / `AI_GROQ_API_KEY` | AI provider failover | Old key stops working at the provider; dual-run briefly if the provider supports key overlap |
| 9 | CI/CD secrets: `PROD_DATABASE_URL`, `KUBECONFIG`, `GHCR` token | GitHub Actions | Rotate in repo settings; re-run a no-op workflow to verify |
| 10 | Any personal access tokens / kubeconfigs ever pasted into docs, tickets, or shell history | Humans | Revoke at the issuer; they are out of scope of code rotation but in scope of this runbook |

> **Name-skew note:** `SMTP_*` is now unified to `SMTP_PASSWORD` in code,
> `.env.example`, and the k8s secrets template. One skew remains pending
> the go-live env repair: the code reads `MFA_TOTP_WINDOW` while
> `.env.example` documents `MFA_WINDOW`. Rotate under the canonical name
> once unified, and delete dead aliases from the secret manager at the same
> time so they cannot be resurrected by accident.

> **`JWT_REFRESH_SECRET` is NOT in this inventory.** It was removed from the
> code (refresh tokens are opaque, not JWTs). Do not rotate it — delete any
> lingering entries from secret managers and `.env` files so nobody sets it
> by habit. Single source of truth: `apps/api/src/config/configuration.ts`.

## 2. Rotation order (minimises downtime)

1. **External services first** (DB password, Redis, S3/MinIO, SMTP, OAuth,
   AI keys): create the new credential *alongside* the old where the
   provider allows it.
2. **Update the secret manager** (or `k8s/secrets.yaml` via External
   Secrets — never commit the rendered file).
3. **Rolling restart** API → worker → web, verifying health endpoints
   between waves. API replicas must pick up `JWT_ACCESS_SECRET` together;
   a rolling update is fine because in-flight access tokens are ≤15 min
   old and clients refresh.
4. **Revoke/disable the old credential at the provider.**
5. **Verify**: sign in, upload + download a document, run a dry payroll,
   send a test invitation email.
6. **Log it** (§7) and destroy any local copies (shell history, scratch
   files: `shred -u` or secret-manager version deletion).

## 3. DOCUMENT_ENCRYPTION_KEY — special procedure

Document blobs are encrypted per-object with AES-256-GCM; each object
carries a `keyId` column. The full re-encryption procedure is in
[KEY_ROTATION.md](KEY_ROTATION.md) §1 — read it end to end before touching
this key. Critical caveats:

- **Dual-key support (`DOCUMENT_ENCRYPTION_KEY_PREVIOUS`) does NOT exist
  in code yet** (verified in the tree: no references). Until that lands,
  there is no online dual-key rotation — schedule a maintenance window,
  re-encrypt all blobs, then switch the single key. Do NOT attempt the
  KEY_ROTATION.md dual-key dance without confirming `_PREVIOUS` support
  in `documents.service.ts` first.
- **Backups are tied to the key active when taken.** Annotate every backup
  file with its `keyId`; after rotation, old backups can only be restored
  with the old key — keep the old key's *sealed* copy in the secret
  manager (disabled, audited access) until those backups age out.
- Emergency (suspected compromise): same procedure, PLUS rotate
  `JWT_ACCESS_SECRET` (forces re-login), S3 credentials, and treat any
  document downloaded during the exposure window as potentially disclosed —
  notify the DPO.

## 4. Git-history treatment — two options, pick one deliberately

### Option A — Rotate and move on (recommended default)

Rotate every credential per §§1–3, verify, log. Leave history untouched.
Rationale: once rotated, the old values in history are inert strings;
rewriting history is disruptive and does not undo any exposure that already
happened (anyone who cloned the repo already has them — which is exactly
why we rotate).

Choose A unless a regulator, contract, or the DPO explicitly requires
history purging.

### Option B — History rewrite (purge secrets from git)

Only if required. Procedure:

1. **Rotate FIRST** (Option A). Rewriting history without rotating is
   security theatre.
2. Rewrite with `git filter-repo` (or BFG Repo-Cleaner), removing the
   identified files/values from all branches and tags.
3. `git push --force` every branch; delete and re-push tags. **Consequences:**
   every clone/fork is invalidated — all developers must re-clone; open
   PRs must be rebased onto the rewritten history; CI caches and any
   mirrors/CDN copies of the repo must be purged; branch protection rules
   may need temporary adjustment for the force-push.
4. Notify the team in writing: who must re-clone, by when, and that old
   clones must be deleted (they still contain the secrets).
5. Expire any deploy keys / tokens that touched the old history if they
   were scoped broadly.

**Decision record:** the team chose Option ___ on ___ (date) because ___.
(File this line in the rotation log.)

## 5. Ongoing rotation discipline

- **Cadence:** JWT/SMTP/S3/Redis/AI keys — rotate at least annually, and on
  every personnel departure with secret access, on any suspected leak, and
  after any incident. `DOCUMENT_ENCRYPTION_KEY` — annually, via the
  §3 procedure once dual-key support exists.
- **Automation:** prefer the secret manager's rotation feature (e.g. RDS
  rotation, short-lived IAM credentials) over manual rotation where
  available.
- **Detection:** gitleaks in CI is the backstop; treat any CI gitleaks
  failure as a P0 — rotate the leaked value immediately (history or not).

## 6. Verification checklist (run after the burn-down)

- [ ] `git log -p` / gitleaks scan of full history lists no *live*
      credentials (historical values documented as rotated in the log).
- [ ] No `.env` files with real values in any clone, CI artifact, or
      backup included in the repo.
- [ ] All 10 inventory items rotated; old values revoked/disabled at the
      provider.
- [ ] Health checks green; sign-in, document upload/download, invitation
      email, and a dry payroll run all verified post-rotation.
- [ ] Rotation log (§7) complete; history-treatment decision recorded.

## 7. Rotation log template

| Date | Secret | Operator | Reason (scheduled / departure / suspected leak / go-live burn-down) | New value location (manager path, never the value) | Old value destroyed (provider + local copies) |
|------|--------|----------|---------------------------------------------------------------------|----------------------------------------------------|-----------------------------------------------|
|      |        |          |                                                                     |                                                    |                                               |

Keep this log outside the repository (secret manager, ticket system, or
encrypted ops doc) — it names which secrets exist and when they changed,
which is itself sensitive.
