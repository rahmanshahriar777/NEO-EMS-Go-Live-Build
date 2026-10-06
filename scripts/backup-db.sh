#!/usr/bin/env bash
# ==============================================================================
# Database Automated Backup Script for PostgreSQL
# ==============================================================================
# Target selection:
#   1. DATABASE_URL set  -> pg_dump against it (production / managed Postgres).
#   2. otherwise         -> pg_dump via the dev compose container ems-postgres.
# Requires a local pg_dump when DATABASE_URL is used (postgres:16 client or
# `apt install postgresql-client`). Never logs the connection string.
# ==============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/ems_backup_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"

echo "📦 Starting PostgreSQL database backup (custom format -Fc)..."

if [ -n "${DATABASE_URL:-}" ]; then
  echo "   target: managed PostgreSQL via DATABASE_URL (value redacted)"
  pg_dump "${DATABASE_URL}" --format=custom --no-owner --no-acl --file="${BACKUP_FILE}"
else
  echo "   target: dev compose container ems-postgres"
  docker exec -t ems-postgres pg_dump -U "${POSTGRES_USER:-ems_admin}" -d "${POSTGRES_DB:-ems_db}" --format=custom --no-owner --no-acl > "${BACKUP_FILE}"
fi

echo "✅ Backup successfully created at: ${BACKUP_FILE}"
echo "File size: $(du -h "${BACKUP_FILE}" | cut -f1)"
echo "⚠️  Encrypt or move this backup to secure storage — it contains PII."
