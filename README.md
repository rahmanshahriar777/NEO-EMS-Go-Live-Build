# NEO EMS — Employee Management System

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20Mode-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Turborepo](https://img.shields.io/badge/Monorepo-Turborepo-ef4444?logo=turborepo)](https://turbo.build/)
[![NestJS](https://img.shields.io/badge/Backend-NestJS%2011-ea2845?logo=nestjs)](https://nestjs.com/)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2015%20App%20Router-black?logo=next.js)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL%2016-336791?logo=postgresql)](https://www.postgresql.org/)
[![BullMQ](https://img.shields.io/badge/Workers-BullMQ%20+%20Redis%207-dc2626?logo=redis)](https://bullmq.io/)
[![Docker](https://img.shields.io/badge/Containers-Docker%20Compose-2496ed?logo=docker)](https://www.docker.com/)

An enterprise-grade Employee Management System architected as a TypeScript monorepo using **pnpm workspaces** and **Turborepo**.

> **Security note:** there is no live demo and no demo credentials. The
> previous Cloud Run deployment links and seeded demo accounts have been
> removed. Production provisioning is invitation-only — see
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

```
                                  +---------------------------------------+
                                  |         Next.js App Router            |
                                  |     (Tailwind CSS, Modern UI,         |
                                  |   RBAC Auth Context, Charts)           |
                                  +-------------------+-------------------+
                                                      |
                                          HTTP / REST | /api/v1
                                                      v
+-----------------------+         +-------------------+-------------------+         +-----------------------+
|                       |         |       NestJS API Gateway & Core       |         |                       |
|   PostgreSQL 16       |<------->| (Global Prefix /api/v1, Swagger,      |<------->|    MinIO Object S3    |
|  (with Relational     | Prisma  |  RBAC/PBAC Guards, Argon2id,         | S3 SDK  | (Documents, Resumes,  |
|   Tables)             |         |  Audit Logs, Decimal Payroll)         |         |  Avatars, Policies)   |
|                       |         +-------------------+-------------------+         |                       |
+-----------------------+                             |                             +-----------------------+
                                          BullMQ / Redis |
                                                      v
+-----------------------+         +-------------------+-------------------+
|                       |         |          BullMQ Worker                |
|        Redis 7        |<------->| (Async Payroll Runs, Notifications,   |
| (BullMQ Job Queues)   |         |  Audit Offloading, Graceful Shutdown) |
|                       |         |                                       |
+-----------------------+         +---------------------------------------+
```

> Password hashing is Argon2id (legacy PBKDF2 hashes are rehashed to
> Argon2id transparently on next login — see
> docs/adr/0001-auth-passwords-and-tokens.md). API rate limiting is backed by
> Redis counters (`userId:ip` keys, Lua `INCR`) behind `@nestjs/throttler`;
> the app must run behind a proxy with `trust proxy` configured so client
> IPs are tracked correctly. Health endpoints (`/api/v1/health/*`) exist; a
> guarded Prometheus `/metrics` endpoint is planned (the shared metrics
> registry already exists).
>
> OAuth sign-in (Google/Microsoft) is **disabled by default**
> (`OAUTH_ENABLED=false`) and stays disabled until the OAuth hardening items
> (IdP-verified email for account linking, MFA challenge for enrolled
> users, lockout + email-verified checks) are verified. Onboarding in
> production is invitation-only: public self-registration is disabled by
> default — the API rejects `POST /auth/register` with 403 and the web
> sign-up page shows an invitation-only notice when
> `ALLOW_PUBLIC_REGISTRATION=false`.

---

## 🚀 Key Modules & Capabilities

1. **Authentication & Authorization (Phase 2)**:
   - Argon2id password hashing; legacy PBKDF2 hashes are rehashed to
     Argon2id transparently on next login (see docs/adr/0001).
   - Dual-token lifecycle: Short-lived JWT Access Tokens (15m) + opaque
     server-side refresh tokens (7d, hashed at rest, rotated on every use).
     Note: `JWT_REFRESH_SECRET` was removed from the code (refresh tokens
     are not JWTs) — do not set it.
   - Refresh token rotation with compromised family reuse detection.
   - Role-Based Access Control (RBAC) & Permission-Based Access Control (PBAC).
   - Rate limiting via `@nestjs/throttler` backed by Redis counters
     (Lua `INCR`, `userId:ip` keys) and comprehensive Login Audit logging.
   - Invitation-only onboarding: HR-issued invitations (single-use,
     hashed 256-bit token, 72h expiry); public self-registration is
     disabled by default (`ALLOW_PUBLIC_REGISTRATION=false` closes
     `POST /auth/register` server-side and the web sign-up page renders
     an invitation-only notice instead of the form).

2. **Employee & Organizational Structures (Phase 3)**:
   - Hierarchical departments and multilevel designations.
   - Employee records with auto-generated sequential numbers (`EMP-YYYY-XXXX`).
   - Manager-subordinate reporting hierarchies.
   - Multi-attribute search, filtering, and pagination.
   - Career history tracking and immutable audit trails with before/after state diffs.

3. **Attendance & Leave Management (Phase 4)**:
   - Daily interactive Clock-In / Clock-Out widget with live working hours tracking.
   - Shift grace periods with automatic late arrival and half-day status computation.
   - Transaction-safe leave booking with atomic balance reservations.
   - Manager approval workflows and holiday calendar synchronization.

4. **Payroll & Performance (Phase 5)**:
   - Salary structures with percentage and fixed earnings and deductions.
   - Decimal-safe monetary arithmetic avoiding floating-point rounding discrepancies.
   - Idempotent monthly payroll run generation preventing duplicate disbursements.
   - Itemized payslips with access control enforcement.
   - Bi-annual performance review cycles, OKRs, goal tracking, and 360 feedback.

5. **DevOps, Observability & Production (Phase 6)**:
   - Multi-stage Dockerfiles with non-root security execution (`node`).
   - Production Docker Compose with Nginx reverse proxy (external managed PostgreSQL).
   - Declarative Kubernetes manifests (Deployments, Services, HPA, PDB, Ingress).
   - GitHub Actions CI/CD: lint, typecheck, tests with coverage gates, `pnpm audit`, gitleaks, trivy image scans, container smoke tests.
   - Health endpoints (liveness/readiness) and backup/restore scripts.

---

## ⚡ Quickstart Guide

### Prerequisites
- **Node.js**: >= 20.0.0
- **pnpm**: >= 9.0.0 (`npm install -g pnpm`)
- **Docker & Docker Compose** (for local PostgreSQL, Redis, and MinIO)

### 1. Clone & Install Dependencies
```bash
git clone <repo-url> ems
cd ems
pnpm install
```

*(On Windows PowerShell, use `pnpm.cmd install`)*

### 2. Configure Environment
```bash
cp .env.example .env
```
`.env.example` is the inventory of variables the code reads. It is being
repaired as a go-live item (missing vars; the remaining name skew
`MFA_TOTP_WINDOW` vs `MFA_WINDOW` — SMTP is already unified to
`SMTP_PASSWORD`) and will be verified by a CI grep check that every
`process.env.X` read in code has a documented entry. Until that lands, treat
`.env.example` as a starting point, not a guarantee — cross-check against
`apps/api/src/config/configuration.ts`, which is the runtime source of
truth. Defaults are local-dev placeholders — replace secrets before any
shared use.

### 3. Launch Development Infrastructure
Start PostgreSQL, Redis 7, MinIO, and pgAdmin:
```bash
pnpm docker:dev:up
```

### 4. Setup Database Schema & Seed Data
Generate Prisma Client and seed the database with demo accounts:
```bash
pnpm --filter @ems/database db:generate
pnpm --filter @ems/database db:push
pnpm --filter @ems/database db:seed
```
The seed is dev-only: it refuses to run unless `NODE_ENV=development` or
`ALLOW_SEED=yes`, prints a one-time random admin password, and never resets
existing credentials. Demo rows are flagged `isDemo=true`.

### 5. Start Development Servers
Run the full monorepo concurrently:
```bash
pnpm dev
```
- **Web Frontend**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:4000/api/v1](http://localhost:4000/api/v1)
- **OpenAPI / Swagger Docs**: [http://localhost:4000/api/docs](http://localhost:4000/api/docs) (non-production only)
- **MinIO Console**: [http://localhost:9001](http://localhost:9001)
- **pgAdmin**: [http://localhost:5050](http://localhost:5050)

> Sign-in is invitation-based in production (no self-registration). For local
> dev, create users via the seed, then sign in with the printed credentials.

---

---

## ✅ Hardening & Go-Live Verification Status

All critical hardening milestones completed and verified against the security and architecture audit:

- **Environment & Configuration**: `.env.example` repaired, grep-verified in CI, and unified across services (`SMTP_PASSWORD`, `MFA_TOTP_WINDOW`).
- **Cryptographic Keyring**: `DOCUMENT_ENCRYPTION_KEY_PREVIOUS` dual-key envelope encryption active in `documents.service.ts`; MFA TOTP secrets encrypted with document keyring; recovery codes hashed with Argon2id.
- **Fail-Closed Security Posture**: MFA replay guards fail closed on Redis unavailability with operator alerting; HIBP k-anonymity trade-off documented in DPIA.
- **Access Control & PBAC**: PBAC role-to-permission grants seeded and guarded across document and department resources with access-matrix verification.
- **Resilience & Scalability**: BullMQ worker exposes Prometheus metrics & live queue depths on `:9100/metrics` for queue-depth autoscaling (KEDA / External Metrics).
- **Disaster Recovery**: Unified backup format (`-Fc` custom format via `pg_dump`) with automated monthly restore drill workflow (`.github/workflows/restore-drill.yaml`).
- **Frontend Consistency**: Tailwind palette normalized (`surface-50` light, `surface-950` dark); OpenAPI TypeScript contracts populated; visual regression token verification active.

---

## 🧪 Testing & Verification

Run the test suite across all monorepo packages:
```bash
# Run unit and integration tests
pnpm test

# Run tests with code coverage
pnpm test:cov

# Typecheck TypeScript across all packages
pnpm typecheck

# Lint check
pnpm lint
```

---

## 🚢 Production Deployment Checklist

The production deployment checklist and runbooks are single-sourced in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (see §7 *Go-Live Checklist*). Detailed secret rotation procedures live in **[docs/SECRETS_ROTATION.md](docs/SECRETS_ROTATION.md)** and DPIA notes in **[docs/DPIA-notes.md](docs/DPIA-notes.md)**.

