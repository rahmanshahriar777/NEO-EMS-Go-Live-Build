-- scripts/apply-enum-values.sql
--
-- Go-live Phase 1 item 1: PostgreSQL forbids `ALTER TYPE ... ADD VALUE`
-- inside a transaction block, and `prisma migrate deploy` wraps every
-- migration file in one transaction. The three enum additions that were
-- originally in `20261005133000_reconcile_phase3/migration.sql` live here
-- instead.
--
-- The deploy pipeline runs this file with psql AFTER `prisma migrate deploy`
-- (the enum TYPES are created by the baseline migration, so the values can
-- only be added once the types exist; they are needed at runtime, not by any
-- migration):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/apply-enum-values.sql
--
-- IMPORTANT: do NOT run this with `psql --single-transaction` (or inside an
-- explicit BEGIN/COMMIT): each statement below must auto-commit on its own,
-- because ADD VALUE is illegal inside a transaction block — including inside
-- a DO block or plpgsql function, which is why the existence checks are done
-- with IF NOT EXISTS instead of pg_enum probes.
--
-- Idempotent: IF NOT EXISTS makes re-runs (and runs against a DB that
-- already has the values) safe. Values match schema.prisma:
--   enum LeaveStatus  { ..., DRAFT }
--   enum AuditAction  { ..., READ, DOCUMENT_DOWNLOAD }

ALTER TYPE "LeaveStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'READ';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DOCUMENT_DOWNLOAD';
