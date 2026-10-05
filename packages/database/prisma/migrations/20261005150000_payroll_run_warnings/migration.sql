-- v4 fix #8: persist payroll-run exclusion warnings.
-- Employees excluded from a run's compute (exited before the pay month,
-- missing termination date, zero days present in the month) are recorded on
-- the run as JSON so the payroll-runs API surfaces them instead of silently
-- dropping people from payroll.
ALTER TABLE "payroll_runs" ADD COLUMN "warnings" JSONB;
