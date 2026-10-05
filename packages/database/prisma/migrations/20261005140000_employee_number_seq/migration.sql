-- Go-live Phase 1 item 6: race-free employee-number generation.
--
-- Replaces the `count() + 1` pattern in employees.service.ts (and the
-- MAX()-probe fallback in recruitment.service.ts) with a real Postgres
-- sequence. Both creation paths call `SELECT nextval('employee_number_seq')`
-- and format the result with the shared helper `formatEmployeeNumber`
-- (packages/shared/src/employee-number.ts): EMP-YYYY-NNNN.
--
-- Seeded ABOVE the highest numeric suffix already present so existing
-- numbers (EMP-YYYY-NNNN from the main path and legacy EMP-NNNNN from the
-- recruitment path) are never re-issued. Assumption: every employeeNumber in
-- the table matches one of those two shapes; rows with no trailing digit run
-- contribute nothing to the seed (regexp_match returns NULL → excluded).

CREATE SEQUENCE IF NOT EXISTS employee_number_seq;

-- CORRECTED PRE-RELEASE (2026-10-05, go-live HIGH #8): on a fresh database
-- `migrate deploy` runs this before any employee rows exist, so MAX(...) was
-- NULL and the sequence was left at 0 — the first app-created employee then
-- received EMP-YYYY-0001 and collided with seeded demo rows (seed uses
-- EMP-YYYY-0001..0020) on the UNIQUE constraint. Floor at 999 so the
-- sequence effectively starts at 1000 and can never re-issue a seeded
-- number. This file was corrected before any real database ever applied it.
SELECT setval(
  'employee_number_seq',
  GREATEST(
    999,
    COALESCE(
      (
        SELECT MAX(CAST(SUBSTRING("employeeNumber" FROM '[0-9]+$') AS INTEGER))
        FROM "employees"
      ),
      0
    )
  )
);
