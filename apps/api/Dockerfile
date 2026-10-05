# Multi-stage production Dockerfile for NestJS API
#
# Pinned base image (2026-10-05): node:20.19-alpine3.22.
# The `dependencies`/`builder` stages install python3/make/g++ because the
# `argon2` native module (Phase 1 password hashing) compiles via node-gyp.
FROM node:20.19-alpine3.22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
# Native build toolchain for argon2 (builder stages only need it, but base is
# shared; the final `runner` stage starts FROM node:20.19-alpine3.22 directly
# and stays toolchain-free).
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Stage 1: Dependencies
FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM dependencies AS builder
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/api apps/api

RUN pnpm --filter @ems/database db:generate
# NOTE: db:generate must precede the shared build — packages/shared asserts
# enum parity against the generated Prisma types (type-only import).
RUN pnpm --filter @ems/shared build
RUN pnpm --filter @ems/api build

# Produce a pruned production install (no devDependencies) for the runner
# stage. `pnpm deploy` resolves the workspace graph and writes exactly the
# runtime deps + built artefacts into /deploy/apps/api.
RUN pnpm deploy --filter @ems/api --prod /deploy/apps/api

# Stage 3: Runner — production-only dependencies, no devDeps.
FROM node:20.19-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl

# Security: Non-root user
USER node

# Copy pruned deployment artefact from builder (prod deps only).
COPY --chown=node:node --from=builder /deploy/apps/api/node_modules ./node_modules
# Workspace packages that @ems/api depends on at runtime.
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/database/prisma ./packages/database/prisma
COPY --chown=node:node --from=builder /app/packages/database/package.json ./packages/database/package.json
COPY --chown=node:node --from=builder /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=builder /app/apps/api/package.json ./apps/api/package.json

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:4000/api/v1/health/liveness || exit 1

CMD ["node", "apps/api/dist/main.js"]
