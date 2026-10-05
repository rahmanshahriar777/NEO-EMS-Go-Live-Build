#!/usr/bin/env bash
# ==============================================================================
# backup-prod.sh — pre-migration production database backup (deploy-prod.yaml).
#
# Takes a pg_dump (custom format, compressed) of the production database and
# uploads it to object storage BEFORE any migration runs, so a failed
# migration can be recovered from a known-good snapshot.
#
# Usage (called by .github/workflows/deploy-prod.yaml):
#   PROD_DATABASE_URL=... BACKUP_S3_BUCKET=s3://ems-prod-backups \
#     AWS_REGION=eu-west-2 bash scripts/backup-prod.sh
#
# ASSUMPTIONS (documented per go-live hardening spec):
#   1. PROD_DATABASE_URL points at the managed production PostgreSQL.
#      Never logs the connection string.
#   2. Object storage is S3-compatible and reachable via the AWS CLI
#      (preinstalled on GitHub-hosted ubuntu runners). For MinIO-style
#      endpoints set AWS_ENDPOINT_URL to the storage endpoint; for AWS set
#      AWS_REGION. Credentials come from the standard AWS env vars
#      (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) or the runner's IAM role.
#   3. BACKUP_S3_BUCKET names the destination bucket/prefix, e.g.
#      "s3://ems-prod-backups/pre-migration". The bucket must already exist;
#      versioning + lifecycle expiry are the bucket owner's responsibility
#      (this script does NOT create the bucket or set retention).
#   4. Dump format is pg_dump custom (-Fc). Restore with:
#        pg_restore --clean --if-exists -d "$PROD_DATABASE_URL" <file.dump>
#      or see scripts/restore-db.sh (which expects .sql.gz — gunzip first
#      is NOT needed for -Fc dumps; use pg_restore directly).
#   5. The dump is a point-in-time snapshot, NOT a substitute for the managed
#      DB's point-in-time recovery. Both should exist for production.
#   6. The backup contains PII — the bucket must be private with
#      server-side encryption enabled.
#
# Prints the uploaded object key on stdout (last line) for the workflow log.
# ==============================================================================
set -euo pipefail

: "${PROD_DATABASE_URL:?PROD_DATABASE_URL must be set}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set (e.g. s3://ems-prod-backups/pre-migration)}"

command -v pg_dump >/dev/null || { echo "FATAL: pg_dump not found on PATH" >&2; exit 1; }
command -v aws >/dev/null || { echo "FATAL: aws CLI not found on PATH" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR_TMP="$(mktemp -d)"
trap 'rm -rf "$WORKDIR_TMP"' EXIT
DUMP_FILE="$WORKDIR_TMP/ems_prod_${STAMP}.dump"

echo "backup: pg_dump (custom format) of production database (connection string redacted)..." >&2
# --no-owner/--no-acl keep the dump portable across managed-DB roles.
pg_dump "$PROD_DATABASE_URL" --format=custom --no-owner --no-acl --file="$DUMP_FILE"
echo "backup: dump complete ($(du -h "$DUMP_FILE" | cut -f1))" >&2

DEST="${BACKUP_S3_BUCKET%/}/ems_prod_${STAMP}.dump"
echo "backup: uploading to ${DEST} ..." >&2
aws s3 cp "$DUMP_FILE" "$DEST" --only-show-errors

echo "backup: OK — pre-migration snapshot stored" >&2
echo "$DEST"
