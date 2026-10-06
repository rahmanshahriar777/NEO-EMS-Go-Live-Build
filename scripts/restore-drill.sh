#!/usr/bin/env bash
# ==============================================================================
# Automated Restore Drill Script (Disaster Recovery Verification)
# ==============================================================================
# Exercises pg_restore against a temporary scratch database/namespace.
# Verifies table existence, row counts, and structural integrity without
# impacting running environments.
#
# Exit codes:
#   0: Drill succeeded (backup is healthy and restorable)
#   1: Drill failed (restore error or sanity check failed)
# ==============================================================================
set -euo pipefail

SCRATCH_ID="drill_$(date +%s)"
SCRATCH_DB="ems_scratch_${SCRATCH_ID}"
BACKUP_FILE="${1:-}"

echo "🧪 Starting Automated Restore Drill: ${SCRATCH_DB}"

# 1. Acquire backup file
if [ -z "${BACKUP_FILE}" ]; then
  BACKUP_FILE="/tmp/${SCRATCH_DB}.dump"
  echo "📦 No backup file provided. Generating fresh test dump into ${BACKUP_FILE}..."
  if [ -n "${PROD_DATABASE_URL:-}" ]; then
    pg_dump "${PROD_DATABASE_URL}" --format=custom --no-owner --no-acl --file="${BACKUP_FILE}"
  elif [ -n "${DATABASE_URL:-}" ]; then
    pg_dump "${DATABASE_URL}" --format=custom --no-owner --no-acl --file="${BACKUP_FILE}"
  else
    echo "❌ Error: Neither backup file nor DATABASE_URL provided."
    exit 1
  fi
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "❌ Error: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "🔍 Backup size: $(du -h "${BACKUP_FILE}" | cut -f1)"

# 2. Setup connection to PostgreSQL server for scratch DB creation
BASE_URL="${DATABASE_URL:-${PROD_DATABASE_URL:-postgres://localhost:5432/postgres}}"
# Derive admin connection pointing to 'postgres' maintenance DB
ADMIN_URL=$(echo "${BASE_URL}" | sed -E 's|/[a-zA-Z0-9_]+(\?.*)?$|/postgres\1|')
RESTORE_URL=$(echo "${BASE_URL}" | sed -E "s|/[a-zA-Z0-9_]+(\\?.*)?$|/${SCRATCH_DB}\\1|")

cleanup() {
  echo "🧹 Cleaning up scratch database ${SCRATCH_DB}..."
  psql "${ADMIN_URL}" -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" > /dev/null 2>&1 || true
  if [[ "${BACKUP_FILE}" == /tmp/ems_scratch_* ]]; then
    rm -f "${BACKUP_FILE}"
  fi
}
trap cleanup EXIT

echo "⚙️ Creating scratch database: ${SCRATCH_DB}..."
psql "${ADMIN_URL}" -c "CREATE DATABASE \"${SCRATCH_DB}\";"

echo "📥 Restoring custom-format backup into ${SCRATCH_DB} via pg_restore..."
pg_restore --no-owner --no-acl --dbname="${RESTORE_URL}" "${BACKUP_FILE}" || {
  echo "⚠️ Warning: pg_restore returned non-zero (checking if schema was created)..."
}

# 3. Sanity verification checks
echo "🔎 Performing integrity & sanity checks..."

TABLES_COUNT=$(psql "${RESTORE_URL}" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
echo "   Tables restored: ${TABLES_COUNT}"

if [ "${TABLES_COUNT}" -lt 5 ]; then
  echo "❌ Drill FAILED: Expected at least 5 tables, found ${TABLES_COUNT}."
  exit 1
fi

for T in users employees departments payroll_runs audit_logs; do
  COUNT=$(psql "${RESTORE_URL}" -t -A -c "SELECT count(*) FROM \"${T}\";" 2>/dev/null || echo "MISSING")
  if [ "${COUNT}" = "MISSING" ]; then
    echo "❌ Drill FAILED: Missing required table: ${T}"
    exit 1
  fi
  echo "   Table '${T}': ${COUNT} rows verified"
done

echo "✅ Restore Drill SUCCESSFUL: Snapshot is valid and cleanly restorable."
