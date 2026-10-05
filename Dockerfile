# ==============================================================================
# *** DEPRECATED — DO NOT BUILD OR DEPLOY FROM THIS FILE ***
# ==============================================================================
# This is the LEGACY all-in-one image (Google Cloud Run era). It is retained
# ONLY so ancient Cloud Run references keep building while they are migrated.
#
# Supported production topology (go-live):
#   apps/api/Dockerfile + apps/worker/Dockerfile + apps/web/Dockerfile,
#   orchestrated via docker-compose.prod.yml or the k8s/ manifests.
#   See docs/DEPLOYMENT.md.
#
# REMOVAL TARGET: delete this file once the last Cloud Run reference is
# migrated (tracked as go-live tech debt). Nothing in this repo may add new
# references to it — CI does not build it and no compose file uses it.
#
# NOTE (preserved): this image still embeds nginx (docker/nginx-gcp.conf);
# it no longer provisions a database — docker/entrypoint.sh requires
# DATABASE_URL and fails closed without it.
# ==============================================================================
#
# Multi-stage production Dockerfile for Google Cloud Run
FROM node:20.19-alpine3.22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Stage 1: Dependencies
FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM dependencies AS builder
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/api apps/api
COPY apps/web apps/web
COPY apps/worker apps/worker

RUN pnpm --filter @ems/shared build
RUN pnpm --filter @ems/database db:generate
RUN pnpm --filter @ems/database build
RUN pnpm --filter @ems/api build
RUN NEXT_PUBLIC_API_URL="/api/v1" pnpm --filter @ems/web build

# Stage 3: Production Runner for Google Cloud Run
FROM node:20.19-alpine3.22 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV PNPM_HOME="/pnpm"
ENV PATH="/app/node_modules/.bin:/app/apps/web/node_modules/.bin:$PNPM_HOME:$PATH"

RUN apk add --no-cache bash curl nginx postgresql postgresql-contrib su-exec
RUN corepack enable

# Copy built workspace
COPY --from=builder /app /app

# Copy Nginx configuration
COPY docker/nginx-gcp.conf /etc/nginx/nginx.conf

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
