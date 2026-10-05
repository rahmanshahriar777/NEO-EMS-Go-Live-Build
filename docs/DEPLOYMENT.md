# NEO EMS — Deployment Guide (single supported topology)

> Status: Phase 1 (release 1.0). This is the ONLY supported production
> topology. The legacy all-in-one Cloud Run image (`Dockerfile` at repo root)
> is deprecated — see the header comment in that file.

## Topology

```
                        ┌─────────────┐
                        │    nginx    │  :80/:443 (TLS terminated here or upstream)
                        └──────┬──────┘
                    ┌──────────┴──────────┐
                    ▼                     ▼
             ┌────────────┐        ┌────────────┐
             │  ems-web   │        │  ems-api   │──┐
             │ (Next.js   │        │ (NestJS    │
             │ standalone)│        │  :4000)    │  │
             └────────────┘        └────────────┘  │
                                                   │ BullMQ
                          ┌────────────┐           │
                          │ ems-worker │◄──────────┘
                          │ (BullMQ)   │
                          └─────┬──────┘
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
   managed PostgreSQL   Redis (compose      MinIO / S3-compatible
   via DATABASE_URL     service or          (compose service or
   (RDS/Cloud SQL)      managed)             managed, PRIVATE buckets)
```

Data services are external/managed for PostgreSQL. Redis and MinIO may run
as the pinned compose services or be replaced by managed equivalents by
overriding `REDIS_*` / `S3_*`. Buckets are ALWAYS private — document access
goes through the authenticated API (AES-256-GCM decrypt + stream).

## Prerequisites

- Node.js ≥ 20, pnpm ≥ 9 (`npm install -g pnpm`), Docker + Compose v2.
- A managed PostgreSQL 16 database and its connection string.
- Secrets generated (placeholders only below — never commit real ones):
  ```bash
  openssl rand -base64 48   # JWT_ACCESS_SECRET
  openssl rand -hex 32      # DOCUMENT_ENCRYPTION_KEY (32-byte HEX for AES-256-GCM)
  openssl rand -base64 32   # REDIS_PASSWORD, S3 keys
  ```
  (`JWT_REFRESH_SECRET` no longer exists: refresh tokens are opaque,
  server-side hashed tokens, not JWTs. Do not set it — it is ignored.)
- **Before go-live: run the secrets burn-down** in
  [docs/SECRETS_ROTATION.md](docs/SECRETS_ROTATION.md) — every credential
  that ever appeared in git history must be treated as compromised and
  rotated (DB passwords, JWT secret, `DOCUMENT_ENCRYPTION_KEY`, Redis/S3/
  SMTP/OAuth/AI keys, CI secrets).

## 1. Configure

```bash
cp .env.example .env.production
# Fill EVERY REQUIRED value (see .env.example header). At minimum:
#   DATABASE_URL, JWT_ACCESS_SECRET, S3_ACCESS_KEY, S3_SECRET_KEY,
#   DOCUMENT_ENCRYPTION_KEY, REDIS_PASSWORD, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
```

`.env.example` is being repaired as a go-live item: the review found
~24 variables the code reads that are not documented there, plus name
skews that must become ONE name everywhere (code + docs + k8s secrets
template). SMTP is already unified to `SMTP_PASSWORD`; the remaining skew
is `MFA_TOTP_WINDOW` (code) vs `MFA_WINDOW` (example). After that repair lands, `.env.example` is treated
as a build artifact: a CI grep check fails the build if any
`process.env.X` read in code lacks a documented entry. **Until then, do
not trust it as complete** — cross-check against
`apps/api/src/config/configuration.ts`, which is the runtime source of
truth. The compose file additionally fails fast (`${VAR:?...}`) when a
required value is missing.

## 2. Build

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production build
```

Images: `ems-api:prod`, `ems-worker:prod`, `ems-web:prod` (multi-stage,
non-root `node` user, pinned `node:20.19-alpine3.22` base; the api builder
carries python3/make/g++ for the `argon2` native module — the runner does not).

### Web client configuration is baked at build time (F6)

Every `NEXT_PUBLIC_*` variable the web app reads is **inlined into the client
JavaScript bundle when the image is built**. Setting one as a runtime env var
(on the container, in compose `environment:`, or in a k8s manifest) has **no
effect on browser code** — client-side API calls will keep using whatever was
baked in. (This is why k8s must NOT set `NEXT_PUBLIC_*` as pod env vars.)

The full inventory lives as `ARG`s in `apps/web/Dockerfile` (builder stage);
defaults mirror `apps/web/.env.example`:

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `/api/v1` | Primary API base URL. `/api/v1` = same-origin Next.js rewrite → API. |
| `NEXT_PUBLIC_API_URL` | _(empty)_ | Deprecated legacy fallback, honoured if the above is unset. |
| `NEXT_PUBLIC_TIMEZONE` | `Europe/London` | Display timezone. |
| `NEXT_PUBLIC_LOCALE` | `en-GB` | Display locale. |
| `NEXT_PUBLIC_CURRENCY` | `GBP` | Display currency. |
| `NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION` | `false` | Shows the `/register` form (API 403s regardless). |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | _(empty)_ | Fallback; the client prefers the API-published key. |
| `NEXT_PUBLIC_SITE_NAME` / `_LATITUDE` / `_LONGITUDE` / `_RADIUS_METERS` | _(empty)_ | Site geofence for location-checked clock-in. |

**Changing any of these requires rebuilding the `ems-web` image:**

- **CI (k8s):** set the matching repository/org **Variables** (same names, e.g.
  `NEXT_PUBLIC_API_BASE_URL=https://ems.yourcompany.com/api/v1` for the direct
  cross-origin topology) — `docker-build.yaml` passes them as build-args.
  A redeploy of an already-built image changes nothing client-side.
- **Compose:** set them as build `args` in `docker-compose.prod.yml`
  (interpolated from your shell/`.env`, e.g. `NEXT_PUBLIC_API_BASE_URL`),
  then `docker compose -f docker-compose.prod.yml build web`.

Consequence of build-time baking: **one web image = one API URL.** If two
environments need different API origins, build a separate `ems-web` image per
environment (the image tags are per-commit anyway — see "Image tags" below).

### Web → API server-side rewrite target (`API_INTERNAL_URL`, build time)

`next.config.mjs` rewrites browser `/api/*` calls to
`process.env.API_INTERNAL_URL` — and that value is resolved when the image is
**built** (`next build` bakes the rewrite destination into the routes
manifest). Setting `API_INTERNAL_URL` as a runtime env var (compose
`environment:`, k8s pod env) has **no effect on rewrites** — exactly the
in-cluster DNS failure fixed by #5-infra: the image CI pushed to GHCR was
built without the build-arg, so the Dockerfile fallback
`http://api:4000/api/:path*` (a docker-compose service name) was baked in and
did not resolve inside the cluster.

`API_INTERNAL_URL` is a Docker `ARG` in `apps/web/Dockerfile` (builder
stage), wired through every image build:

| Build path | Value passed | Override |
|---|---|---|
| CI publish (`docker-build.yaml`) | `vars.API_INTERNAL_URL` or default `http://ems-api-service:4000/api/:path*` (k8s ClusterIP Service DNS — these images deploy to k8s) | repository/org Variable `API_INTERNAL_URL` |
| Compose (`docker-compose.prod.yml`) | `http://api:4000/api/:path*` (compose service name) | `args` in the compose file |
| Manual | your `--build-arg` | — |

Changing it requires **rebuilding** the `ems-web` image. Manual
verification of a baked value (no k8s needed):

```bash
# Build the builder stage and inspect the baked routes manifest:
docker build --target builder \
  --build-arg API_INTERNAL_URL=http://ems-api-service:4000/api/:path* \
  -f apps/web/Dockerfile -t ems-web:check .
docker run --rm --entrypoint cat ems-web:check \
  /app/apps/web/.next/routes-manifest.json | grep -o '"destination":"[^"]*api[^"]*"'
# Expect: "destination":"http://ems-api-service:4000/api/:path*"
```

`scripts/check-docker-build-args.sh` (run in CI) fails the build if any
`ARG` declared in `apps/web/Dockerfile` is not passed as a build-arg in
`docker-build.yaml`, so this class of omission is caught before publish.

## 3. Migrate (release pipeline step)

> ⚠️ **FRESH INSTALLS: apply the enum values AFTER `migrate deploy`.**
> `scripts/apply-enum-values.sql` applies the three enum additions that
> PostgreSQL forbids inside a transaction (`LeaveStatus.DRAFT`,
> `AuditAction.READ`, `AuditAction.DOCUMENT_DOWNLOAD` — moved out of
> `20261005133000_reconcile_phase3/migration.sql` because `migrate deploy`
> wraps every migration in one transaction). It is idempotent
> (`ADD VALUE IF NOT EXISTS`), so re-runs are safe:
>
> ```bash
> pnpm --filter @ems/database prisma migrate deploy
> psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/apply-enum-values.sql
> ```
>
> Run it AFTER `prisma migrate deploy` on every fresh database — the enum
> TYPES are created by the baseline migration, so the values can only be
> added once the types exist. (The values are needed at runtime, not by any
> migration, so `migrate deploy` itself succeeds without this step; skipping
> it leaves the DB missing values the application writes.) The deploy
> pipeline runs this file with `psql` immediately after `migrate deploy`.
>
> ⚠️ **Verification note:** the enum step has not yet been exercised against
> a real PostgreSQL in this build (no live DB in the sandbox). The go-live
> acceptance is `migrate deploy` + the enum step succeeding on a scratch DB
> — confirm both run cleanly there before relying on them.

```bash
pnpm install --frozen-lockfile
pnpm --filter @ems/database db:generate
DATABASE_URL="<managed>" pnpm --filter @ems/database prisma migrate deploy
```

Rules: versioned migrations only — never `db push` outside local dev, never
boot-time migration/seed in production images (the containers fail closed
instead).

**Pipeline order for production deploys (target state):**
1. Green CI gate — `deploy-prod.yaml` must not run unless CI passed
   (`workflow_run` or `needs`).
2. **Automated pre-migration backup** (`scripts/backup-db.sh` against the
   managed DB, backup stored encrypted, retention per policy).
3. `prisma migrate deploy`.
4. Rollout of the new images.
5. On any failure: `kubectl rollout undo deployment/<name> -n ems-production`
   (and restore the pre-migration backup only if a migration actually
   changed data — prefer roll-forward fixes for schema issues).

> Status: the current `deploy-prod.yaml` runs `prisma migrate deploy` with
> no CI gate, no backup step, and no automated rollback — the gating,
> backup, and `rollout undo` steps above are a go-live item in progress.

## 4. First admin (no self-registration in production)

Self-registration is closed. Provision the first admin with
`scripts/create-first-admin.ts` (B2), then invite further users by email.

## 5. Run

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

## 6. Verify

```bash
curl -f http://localhost:80/api/v1/health/liveness   # via nginx → api
curl -f http://localhost:80/                          # via nginx → web
docker compose -f docker-compose.prod.yml logs worker | grep worker.listening
```

Fail-closed negative check (api must refuse to boot without secrets):

```bash
docker run --rm -e NODE_ENV=production ems-api:prod; echo "exit=$?"
# expect non-zero: "Missing required secrets: DATABASE_URL, ..."
```

## Kubernetes

```bash
# 1. Fill k8s/secrets-template.yaml → k8s/secrets.yaml (or wire External Secrets).
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/pdb.yaml
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/web-deployment.yaml
kubectl apply -f k8s/worker-deployment.yaml
kubectl apply -f k8s/ingress.yaml
# 2. Run migrations as a release-pipeline step (after the automated backup,
#    see §3 above) — `deploy-prod.yaml` runs `prisma migrate deploy`
#    directly before applying the manifests, not as a Kubernetes Job.
# 3. Set image tags to the immutable per-commit tags CI publishes (see
#    "Image tags" below) — never :latest.
```

PostgreSQL/Redis/S3 are external via `ems-config` + `ems-secrets`
(`DATABASE_URL`, `REDIS_HOST`, `S3_ENDPOINT`, …). Probes: api liveness
`/api/v1/health/liveness`, readiness `/api/v1/health/readiness` (503 when
DB/Redis are down); web `/`; worker has no HTTP probes (BullMQ heartbeat +
structured logs; PDB intentionally omitted for the single-replica worker).

## Image tags (target scheme — in progress)

- `docker-build.yaml` publishes **per-commit SHA tags**
  (`ghcr.io/<org>/ems-api:sha-<short-sha>`) for every main-branch build,
  plus semver tags (`1.2.3`) on `v*` releases.
- **Never deploy `:latest`.** `deploy-prod.yaml` pins the image fields to
  the built semver/SHA tag for that release.
- k8s manifests must not contain placeholder registries.

> Status: the current tree still publishes only `:latest` (main pushes) +
> semver (releases) — no SHA tags — and `k8s/*-deployment.yaml` still points
> at `ghcr.io/your-org/…` placeholders. Switching the tagging scheme and the
> manifests to real per-commit SHA tags is a go-live item in progress. Do
> not apply the k8s manifests as-is to production.

## Backups & restore

```bash
BACKUP_DIR=/secure/backups DATABASE_URL="<managed>" ./scripts/backup-db.sh
./scripts/restore-db.sh /secure/backups/ems_backup_<ts>.sql.gz   # typed confirmation
```

Backups contain PII — encrypt at rest and restrict access. Document
encryption keys are rotated per `docs/KEY_ROTATION.md` (backups are tied to
the key active when taken — note the `keyId` in your rotation log).

## Rollback

Images are immutable tags. Roll back with the previous tag:

```bash
# compose: retag or rebuild from the previous git SHA, then up -d
# k8s:
kubectl rollout undo deployment/ems-api -n ems-production
```

Database rollbacks use down migrations only after a backup — prefer
roll-forward fixes.

## Malware scanning — explicit accepted risk

Document uploads pass through a `MalwareScanner` hook
(`apps/api/src/modules/documents/malware-scanner.interface.ts`) before
encryption/storage. The current state is:

- **Default is `NoopMalwareScanner`** (reports every buffer clean — it only
  exists as a hook; magic-bytes validation is the only real inspection).
- **Fail-closed when a real scanner is configured**: if
  `DOCUMENT_MALWARE_SCAN_ENABLED=true` but no real `MalwareScanner` is
  registered for the `MALWARE_SCANNER` DI token, the API refuses to boot
  rather than storing unscanned files.
- **A ClamAV sidecar is deferred** — the interface documents exactly how to
  wire one (`clamdjs` + a `ClamAvScanner` implementation), but no scanner
  implementation is bundled or deployed.

This is an **accepted risk** for the go-live release: the hook, the
fail-closed boot check, and the per-upload audit entry (scanner name +
result) are in place, so a scanner can be added without schema or API
changes. **Re-evaluation trigger: before the platform handles customer PII
documents at scale** (or before any production handling of documents from
untrusted sources), a real scanner (ClamAV sidecar or a provider hook)
must be wired and `DOCUMENT_MALWARE_SCAN_ENABLED=true` set in production.
`DOCUMENT_MALWARE_SCAN_ENABLED` is read directly by the documents module
and is not yet in `.env.example` (env repair in progress).

## What this guide does NOT cover (other workers / later phases)

- `.env.example` repair + CI grep check (`MFA_TOTP_WINDOW` vs `MFA_WINDOW`
  still skewed), per-commit SHA image tags, k8s manifest registry fixes,
  and deploy-prod gating with backup + rollback (go-live infra/pipeline
  item — target states documented above; current tree is not yet at
  target). The enum pre-step script exists, but `deploy-prod.yaml` does
  not invoke it yet — run it manually per §3.
- `DOCUMENT_MALWARE_SCAN_ENABLED` is not yet in `.env.example` (env repair
  in progress); ClamAV sidecar wiring is deferred — see the accepted-risk
  note above.
- Prometheus `/metrics` wiring: the shared registry exists
  (`packages/shared/src/observability/metrics.ts`); the guarded endpoint is
  still to be mounted by the API owner.
- DPIA sign-off for AI features: see `docs/DPIA-notes.md` (notes only —
  requires DPO review before enabling AI in production).
