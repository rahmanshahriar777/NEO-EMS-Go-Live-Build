#!/usr/bin/env bash
# ==============================================================================
# Production seeding guard (B3/B6 hardening)
# ==============================================================================
# The database seed (packages/database/prisma/seed.ts) is DEV-ONLY: it creates
# demo users with printed-once random passwords and refuses to run unless
# NODE_ENV=development or ALLOW_SEED=yes.
#
# This script is the ONLY sanctioned way to run the seed outside local dev,
# e.g. to provision system roles/permissions on a brand-new production
# database BEFORE the first admin is created. It is fail-closed:
#   - refuses when NODE_ENV=production unless ALLOW_SEED=yes is explicit,
#   - refuses when the database already contains users (never touch real data),
#   - prints a loud warning that demo rows are flagged isDemo=true and must
#     be reviewed.
#
# Normal production provisioning does NOT use this script:
#   1. prisma migrate deploy        (release pipeline)
#   2. scripts/create-first-admin.ts (B2 — invitation-based onboarding)
# ==============================================================================
set -euo pipefail

if [ "${NODE_ENV:-development}" = "production" ] && [ "${ALLOW_SEED:-}" != "yes" ]; then
  echo "❌ FATAL: refusing to seed with NODE_ENV=production." >&2
  echo "   Seeding is dev-only. If you are provisioning a NEW production" >&2
  echo "   database with baseline roles, re-run with ALLOW_SEED=yes and" >&2
  echo "   confirm the database holds no real user data." >&2
  exit 1
fi

if [ "${ALLOW_SEED:-}" = "yes" ] && [ "${NODE_ENV:-development}" = "production" ]; then
  echo "⚠️  WARNING: ALLOW_SEED=yes with NODE_ENV=production." >&2
  echo "   This inserts DEMO users/roles (flagged isDemo=true). Only proceed" >&2
  echo "   on a brand-new database, then create the real first admin via" >&2
  echo "   scripts/create-first-admin.ts and review/remove demo rows." >&2
  read -r -p "Type PROCEED to continue: " confirm
  if [ "$confirm" != "PROCEED" ]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "🌱 Running database seed (NODE_ENV=${NODE_ENV:-development})..."
pnpm --filter @ems/database db:seed

echo "✅ Seed complete. Review demo rows (isDemo=true) before going live."
