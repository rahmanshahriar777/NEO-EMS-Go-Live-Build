-- Missing FK indexes (efficiency audit, go-live hardening).
--
-- Without these indexes every query that filters or joins on these FK columns
-- performs a sequential table scan over what can be a large table.
--
-- 1. invitations(employeeId): HR "pending invitations for an employee" queries
--    and the SET NULL cascade on Employee delete both scan this column.
-- 2. onboarding_tasks(ownerUserId): task assignment queries ("tasks owned by
--    user X") and HR dashboards filter on ownerUserId without a supporting
--    index (the existing @@index covers checklistId+status only).
-- 3. candidates(employeeId): the FK is set when an offer is accepted and an
--    employee is auto-created; reverse-lookups (find candidate record for an
--    employee) and the SET NULL cascade on Employee delete need this index.
--
-- Naming follows the repo convention: "<table>_<column>_idx".
-- All three are CONCURRENTLY to avoid locking the tables during a
-- live migration (safe with Prisma's migrate deploy on an idle maintenance
-- window, and required on a busy replica).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "invitations_employeeId_idx"
  ON "invitations"("employeeId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "onboarding_tasks_ownerUserId_idx"
  ON "onboarding_tasks"("ownerUserId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "candidates_employeeId_idx"
  ON "candidates"("employeeId");
