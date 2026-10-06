-- Align Employee onDelete behavior (GDPR compliance records must survive or restrict hard delete)
-- and backstop company-wide payroll run uniqueness (departmentId IS NULL)

-- 1. Ensure partial unique index exists for company-wide payroll runs
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_runs_month_year_null_dept_uidx"
    ON "payroll_runs"("month", "year")
    WHERE "departmentId" IS NULL;

-- 2. Align goals foreign key from CASCADE to RESTRICT
ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_employeeId_fkey";
ALTER TABLE "goals" ADD CONSTRAINT "goals_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Align documents foreign key from CASCADE to RESTRICT
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_employeeId_fkey";
ALTER TABLE "documents" ADD CONSTRAINT "documents_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Align document acknowledgements employee foreign key from CASCADE to RESTRICT
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'document_acknowledgements' AND constraint_type = 'FOREIGN KEY'
    ) LOOP
        -- check if it references employees
        IF EXISTS (
            SELECT 1 FROM information_schema.constraint_column_usage
            WHERE table_name = 'employees' AND constraint_name = r.constraint_name
        ) THEN
            EXECUTE 'ALTER TABLE "document_acknowledgements" DROP CONSTRAINT ' || quote_ident(r.constraint_name);
        END IF;
    END LOOP;
END $$;

ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
