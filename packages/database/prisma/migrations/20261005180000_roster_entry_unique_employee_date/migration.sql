-- DropIndex
DROP INDEX IF EXISTS "roster_entries_employeeId_date_idx";

-- CreateIndex
CREATE UNIQUE INDEX "roster_entries_employeeId_date_key" ON "roster_entries"("employeeId", "date");
