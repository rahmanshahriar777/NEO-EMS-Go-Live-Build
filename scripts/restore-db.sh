#!/usr/bin/env bash
# ==============================================================================
# Database Restore Script
# ==============================================================================
# Accepts TWO backup formats:
#   1. Custom-format dump (.dump, -Fc) — produced by backup-prod.sh.
#      Restored with `pg_restore --clean --if-exists`.
#   2. Plain SQL dump (.sql.gz) — produced by the older backup-db.sh.
#      Restored with `gunzip -c | psql`.
#
# Target selection:
#   - DATABASE_URL set  → connect against it (production / managed Postgres).
#   - otherwise         → connect via the dev compose container ems-postgres.
#
# IMPORTANT: Restoring OVERWRITES the target database. Requires explicit
# typed confirmation. Irreversible.
# ==============================================================================
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <path_to_backup_file>"
  echo ""
  echo "  Accepted formats:"
  echo "    *.dump       — pg_dump custom format (-Fc), produced by backup-prod.sh"
  echo "    *.sql.gz     — gzip-compressed plain SQL, produced by backup-db.sh"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "❌ Error: Backup file '${BACKUP_FILE}' does not exist."
  exit 1
fi

# Detect format by extension.
case "${BACKUP_FILE}" in
  *.dump)
    FORMAT="custom"
    ;;
  *.sql.gz)
    FORMAT="plain"
    ;;
  *)
    # Try to auto-detect by reading the pg_dump magic bytes.
    # Custom format starts with 0x50 0x47 0x44 0x4D ("PGDM").
    MAGIC=$(head -c 4 "${BACKUP_FILE}" 2>/dev/null | cat -v | head -c 4 || true)
    if [[ "${MAGIC}" == "PGDM" ]]; then
      FORMAT="custom"
    else
      echo "❌ Error: Cannot determine backup format for '${BACKUP_FILE}'."
      echo "   Supported extensions: .dump (custom -Fc), .sql.gz (plain gzip)"
      exit 1
    fi
    ;;
esac

if [ -n "${DATABASE_URL:-}" ]; then
  TARGET_DESC="managed PostgreSQL via DATABASE_URL (value redacted)"
else
  TARGET_DESC="dev compose container ems-postgres"
fi

echo "⚠️  Restoring database from: ${BACKUP_FILE}"
echo "⚠️  Format: ${FORMAT}"
echo "⚠️  Target: ${TARGET_DESC}"
read -r -p "This will OVERWRITE the target database. Type OVERWRITE to continue: " confirm
echo
if [ "$confirm" != "OVERWRITE" ]; then
  echo "Restore aborted."
  exit 0
fi

if [ "${FORMAT}" = "custom" ]; then
  # Custom format: use pg_restore. --clean drops existing objects first;
  # --if-exists avoids errors when the DB is empty.
  command -v pg_restore >/dev/null || { echo "FATAL: pg_restore not found on PATH" >&2; exit 1; }
  if [ -n "${DATABASE_URL:-}" ]; then
    pg_restore --clean --if-exists --no-owner --no-acl \
      -d "${DATABASE_URL}" "${BACKUP_FILE}"
  else
    # Copy the dump into the container and restore from there (pg_restore
    # must read the file directly; it cannot be piped like psql).
    CONTAINER_PATH="/tmp/restore-$(date -u +%s).dump"
    docker cp "${BACKUP_FILE}" "ems-postgres:${CONTAINER_PATH}"
    docker exec ems-postgres \
      pg_restore --clean --if-exists --no-owner --no-acl \
        -U "${POSTGRES_USER:-ems_admin}" \
        -d "${POSTGRES_DB:-ems_db}" \
        "${CONTAINER_PATH}"
    docker exec ems-postgres rm -f "${CONTAINER_PATH}"
  fi
else
  # Plain SQL (gzip): decompress and pipe into psql.
  command -v gunzip >/dev/null || { echo "FATAL: gunzip not found on PATH" >&2; exit 1; }
  if [ -n "${DATABASE_URL:-}" ]; then
    gunzip -c "${BACKUP_FILE}" | psql "${DATABASE_URL}"
  else
    gunzip -c "${BACKUP_FILE}" | \
      docker exec -i ems-postgres psql \
        -U "${POSTGRES_USER:-ems_admin}" \
        -d "${POSTGRES_DB:-ems_db}"
  fi
fi

echo "✅ Database restored successfully."
