# Multi-stage production Dockerfile for BullMQ Worker
#
# Pinned base image (2026-10-05): node:20.19-alpine3.22.
FROM node:20.19-alpine3.22 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

FROM base AS dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY apps/worker apps/worker

RUN pnpm --filter @ems/database db:generate
# NOTE: db:generate must precede the shared build — packages/shared asserts
# enum parity against the generated Prisma types (type-only import).
RUN pnpm --filter @ems/shared build
RUN pnpm --filter @ems/worker build

# Produce a pruned production install (no devDependencies) for the runner
# stage. `pnpm deploy` resolves the workspace graph and writes exactly the
# runtime deps + built artefacts into /deploy/apps/worker.
RUN pnpm deploy --filter @ems/worker --prod /deploy/apps/worker

FROM node:20.19-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production

USER node

# Copy pruned deployment artefact from builder (prod deps only: bullmq,
# ioredis, @google/generative-ai, groq-sdk, dotenv). tsx, typescript,
# rimraf and @types/node are devDeps and will not be present.
COPY --chown=node:node --from=builder /deploy/apps/worker/node_modules ./node_modules
# Workspace packages that @ems/worker depends on at runtime.
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/database/prisma ./packages/database/prisma
COPY --chown=node:node --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node --from=builder /app/apps/worker/package.json ./apps/worker/package.json

CMD ["node", "apps/worker/dist/main.js"]
