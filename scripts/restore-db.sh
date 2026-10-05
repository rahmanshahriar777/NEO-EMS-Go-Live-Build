#!/usr/bin/env bash
# ==============================================================================
# Database Restore Script
# ==============================================================================
# Target selection mirrors backup-db.sh:
#   1. DATABASE_URL set  -> psql against it (production / managed Postgres).
#   2. otherwise         -> psql via the dev compose container ems-postgres.
# Requires explicit typed confirmation. Restoring overwrites the target.
# ==============================================================================
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <path_to_backup_file.sql.gz>"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "❌ Error: Backup file '${BACKUP_FILE}' does not exist."
  exit 1
fi

if [ -n "${DATABASE_URL:-}" ]; then
  TARGET_DESC="managed PostgreSQL via DATABASE_URL (value redacted)"
else
  TARGET_DESC="dev compose container ems-postgres"
fi

echo "⚠️  Restoring database from: ${BACKUP_FILE}"
echo "⚠️  Target: ${TARGET_DESC}"
read -r -p "This will OVERWRITE the target database. Type OVERWRITE to continue: " confirm
echo
if [ "$confirm" != "OVERWRITE" ]; then
  echo "Restore aborted."
  exit 0
fi

if [ -n "${DATABASE_URL:-}" ]; then
  gunzip -c "${BACKUP_FILE}" | psql "${DATABASE_URL}"
else
  gunzip -c "${BACKUP_FILE}" | docker exec -i ems-postgres psql -U "${POSTGRES_USER:-ems_admin}" -d "${POSTGRES_DB:-ems_db}"
fi

echo "✅ Database restored successfully."
