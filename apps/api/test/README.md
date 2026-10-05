# API e2e harness

## Status: implemented, infrastructure-gated

The harness lives in `apps/api/test/`:

| File | Purpose |
|---|---|
| `jest-e2e.json` | Jest config for e2e (`rootDir: test`, `*.e2e-spec.ts`, ts-jest, 60s timeout) |
| `e2e-utils.ts` | `e2eDbOrSkip()` — synchronous TCP probe of the database; specs degrade to a single passing "skipped" test when no DB is reachable |
| `access-matrix.e2e-spec.ts` | Route-by-role matrix over HTTP: public routes reachable, protected routes 401 without credentials / 401 with garbage token / 403 with wrong-role token |
| `leave-approval.e2e-spec.ts` | Leave request → manager approve → balance decremented; non-manager approve → 403; self-approve → 403; approval identity recorded |
| `payroll-concurrency.e2e-spec.ts` | Double-approve race and duplicate payroll-run race: at-most-once semantics against a real DB |
| `testcontainers-harness.e2e-spec.ts` | Phase 3 item 6: boots Postgres via testcontainers when available (Docker daemon + package installed); runs route-by-role matrix with seeded users and the invitation → accept → login flow over HTTP. Skips cleanly with documented manual steps otherwise |

testcontainers is deliberately NOT used by the other specs: it is not installed
in this repo and there is no container runtime in the test environment. The
`testcontainers-harness.e2e-spec.ts` suite probes for it at collection time and
stays green-by-skip when it is missing.

## Running

```bash
cd apps/api

# 1. Provision a scratch database and migrate it:
createdb ems_e2e
DATABASE_URL=postgresql://localhost:5432/ems_e2e pnpm --filter @ems/database prisma migrate deploy
# apply the base seed so roles (MANAGER/EMPLOYEE/HR_ADMIN/...) exist:
DATABASE_URL=postgresql://localhost:5432/ems_e2e pnpm --filter @ems/database prisma db seed

# 2. Run the e2e suite against it:
E2E_DATABASE_URL=postgresql://localhost:5432/ems_e2e npx jest --config ./test/jest-e2e.json
```

Without `E2E_DATABASE_URL` (or `DATABASE_URL`) — or when the host:port is not
reachable — every e2e spec registers a single passing test that records why it
was skipped. This is intentional: a red suite caused by missing infrastructure
erodes trust faster than a documented skip.

### Environment

The specs set `NODE_ENV=test` and throwaway test secrets themselves
(`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`). Only the database URL comes from
your environment. Redis/MinIO are not required: the queue layer is fail-open
and no document bodies are fetched. Never point `E2E_DATABASE_URL` at a real
database — the specs create and leave behind `e2e-*` fixture rows.

### Running the testcontainers harness (Phase 3 item 6)

`testcontainers-harness.e2e-spec.ts` probes at collection time for (a) the
`testcontainers` package and (b) a reachable Docker daemon. In this repo both
are absent, so the suite records a passing skip. To run it for real:

```bash
# 1. Install the harness dependency (API package only):
pnpm --filter @ems/api add -D testcontainers @testcontainers/postgresql

# 2. Start a Docker daemon so /var/run/docker.sock exists
#    (Docker Desktop, or `sudo dockerd` on Linux; alternatively export
#    DOCKER_HOST=tcp://<host>:2375 for a remote daemon)

# 3. Run just the harness:
cd apps/api
npx jest --config ./test/jest-e2e.json testcontainers-harness
```

The harness then starts `postgres:16-alpine`, runs `prisma migrate deploy` +
`prisma db seed` inside the container, boots the app, and asserts:
route-by-role at HTTP level with properly seeded users (401 unauthenticated,
403 for a seeded EMPLOYEE on an HR-only route), plus the full
invitation → accept → login flow (invitation seeded with a known raw token,
accepted over HTTP, replay rejected, login succeeds).

### CI wiring (pending)

Add a job that starts Postgres (service container), runs the migrate + seed
steps above, then `npx jest --config ./test/jest-e2e.json`. Gate the job on
the unit coverage gate in `jest.config.js` — e2e is the next layer, not a
replacement.

## What the e2e suite covers (release-critical paths)

1. **Access matrix (B1)** — `POST /auth/login`, `POST /auth/register`,
   `POST /auth/refresh`, `GET /health/liveness` reachable without credentials;
   `POST /ai/generate`, `GET/PATCH /employees/:id`, `GET /documents/:id`,
   `GET /documents/:id/download` (B5: authenticated, object-level access),
   `POST /payroll/runs/:id/disburse`, `GET /audit/verify`,
   `PATCH /leave-requests/:id/approve` return 401 unauthenticated and 403 for a
   valid token with the wrong role.
2. **Leave approval (B4)** — request → manager approve → `usedDays`
   incremented; non-manager approve → 403; self-approve → 403.
3. **Concurrency** — double-approve race and duplicate payroll-run race assert
   at-most-once. Known limitation: the current approve path is read-then-write
   without a row lock, so the double-approve assertion is the regression net
   for adding a conditional update.
4. **Still unit-tested** (no DB needed): guard chain metadata matrix
   (`src/common/guards/access-matrix.spec.ts`), payroll golden files
   (`src/modules/payroll/payroll.golden.spec.ts`), refresh-token reuse
   (`src/modules/auth/token.service.spec.ts` + `token.reuse-concurrency.spec.ts`).
