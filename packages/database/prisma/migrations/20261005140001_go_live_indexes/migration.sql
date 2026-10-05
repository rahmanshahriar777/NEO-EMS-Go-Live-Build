-- Go-live hardening: missing indexes (Phase 3 item 4).
--
-- 1. refresh_tokens(expiresAt): expiry scans (refresh-token cleanup and
--    rotation bookkeeping) filter on expiresAt; without this the scan is
--    sequential over a table that grows with every login.
-- 2. leave_requests(employeeId, startDate, endDate): leave overlap checks
--    and per-employee date-range queries hit exactly this column set.
--
-- Naming follows the repo convention: "<table>_<columns>_idx".
-- No migration_lock.toml exists in this repo (Prisma 6: optional) — nothing
-- to update there.

CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

CREATE INDEX "leave_requests_employeeId_startDate_endDate_idx" ON "leave_requests"("employeeId", "startDate", "endDate");
