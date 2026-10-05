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

# F6: every NEXT_PUBLIC_* var the app reads is inlined into the client bundle
# at BUILD time — a runtime env var on the container has NO effect on browser
# code (this bit every client-side API call when k8s set NEXT_PUBLIC_API_URL
# only as a runtime env). Each var below must therefore arrive as a build-arg.
# Defaults mirror apps/web/.env.example (complete inventory — grep the web app
# for `NEXT_PUBLIC_` if you add a new one and extend this list).
# Changing ANY of these values requires REBUILDING the web image; redeploying
# the same image changes nothing client-side (see docs/DEPLOYMENT.md).
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_TIMEZONE=Europe/London
ARG NEXT_PUBLIC_LOCALE=en-GB
ARG NEXT_PUBLIC_CURRENCY=GBP
ARG NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION=false
# next.config.mjs also honours the API-named knob at build time, so accept it
# as a build-arg too (it is mapped into NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION).
ARG ALLOW_PUBLIC_REGISTRATION=
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=
ARG NEXT_PUBLIC_SITE_NAME=
ARG NEXT_PUBLIC_SITE_LATITUDE=
ARG NEXT_PUBLIC_SITE_LONGITUDE=
ARG NEXT_PUBLIC_SITE_RADIUS_METERS=
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_TIMEZONE=${NEXT_PUBLIC_TIMEZONE} \
    NEXT_PUBLIC_LOCALE=${NEXT_PUBLIC_LOCALE} \
    NEXT_PUBLIC_CURRENCY=${NEXT_PUBLIC_CURRENCY} \
    NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION=${NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION} \
    ALLOW_PUBLIC_REGISTRATION=${ALLOW_PUBLIC_REGISTRATION} \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY} \
    NEXT_PUBLIC_SITE_NAME=${NEXT_PUBLIC_SITE_NAME} \
    NEXT_PUBLIC_SITE_LATITUDE=${NEXT_PUBLIC_SITE_LATITUDE} \
    NEXT_PUBLIC_SITE_LONGITUDE=${NEXT_PUBLIC_SITE_LONGITUDE} \
    NEXT_PUBLIC_SITE_RADIUS_METERS=${NEXT_PUBLIC_SITE_RADIUS_METERS}

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
