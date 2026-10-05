# Multi-stage production Dockerfile for Next.js Frontend
#
# Pinned base image (2026-10-05): node:20.19-alpine3.22.
# Requires `output: 'standalone'` in apps/web/next.config.mjs — the builder
# emits .next/standalone/server.js, which the runner executes directly.
FROM node:20.19-alpine3.22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/web apps/web

# Build-time API origin for the /api/* rewrites (next.config.mjs). Defaults to
# the compose service name; override with --build-arg in other topologies.
ARG API_INTERNAL_URL=http://api:4000/api/:path*
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

# db:generate must precede the shared build — packages/shared asserts enum
# parity against the generated Prisma types (type-only import).
RUN pnpm --filter @ems/database db:generate
RUN pnpm --filter @ems/shared build
RUN pnpm --filter @ems/web build

FROM node:20.19-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
RUN apk add --no-cache curl

USER node

# Next.js standalone output: server.js lands at the WORKDIR root, with
# .next/static alongside it. (public/ is copied separately — standalone does
# not bundle it.)
COPY --chown=node:node --from=builder /app/apps/web/public ./public
COPY --chown=node:node --from=builder /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=builder /app/apps/web/.next/static ./.next/static

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:3000 || exit 1

CMD ["node", "server.js"]
