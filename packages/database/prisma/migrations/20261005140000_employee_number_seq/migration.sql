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

SELECT setval(
  'employee_number_seq',
  COALESCE(
    (
      SELECT MAX((regexp_match("employeeNumber", '(\d+)$'))[1]::bigint)
      FROM "employees"
    ),
    0
  )
);
