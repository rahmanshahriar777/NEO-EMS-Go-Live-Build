-- Reconciliation migration for Phases 1–3 (coordinator-authored).
-- Covers schema needs reported by workers 1–3 that landed after worker 4's
-- migration, plus enum extensions. All changes are additive except the
-- Role.name / Invitation.role enum→text relaxations and the OAuthAccount
-- unique-constraint reshape, which are required for custom role names and
-- the documented OAuth contract. No data loss: USING clauses preserve values.

-- 1. Role.name: SystemRole enum -> TEXT (custom role names for the role editor)
ALTER TABLE "roles" ALTER COLUMN "name" TYPE TEXT USING "name"::TEXT;

-- 2. Invitation.role: SystemRole enum -> TEXT (invitations can target custom roles)
ALTER TABLE "invitations" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;

-- 3. OAuthAccount: providerUserId -> providerId, composite unique(provider, providerId)
--    matches the documented OAuth contract (worker 1).
ALTER TABLE "oauth_accounts" RENAME COLUMN "providerUserId" TO "providerId";
ALTER TABLE "oauth_accounts" DROP CONSTRAINT "oauth_accounts_providerUserId_key";
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_provider_providerId_key" UNIQUE ("provider", "providerId");

-- 4. Document: fileKey nullable (server-generated storageKey is canonical) + expiry
ALTER TABLE "documents" ALTER COLUMN "fileKey" DROP NOT NULL;
ALTER TABLE "documents" ADD COLUMN "expiresAt" TIMESTAMPTZ(6);

-- 5. DocumentAcknowledgement (policy acknowledgement, Phase 2 item 7)
CREATE TABLE "document_acknowledgements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
    "employeeId" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "document_acknowledgements_documentId_employeeId_key" UNIQUE ("documentId", "employeeId")
);
CREATE INDEX "document_acknowledgements_employeeId_idx" ON "document_acknowledgements"("employeeId");

-- 6. LeaveApproval: approver's USER id (B4 — audit column, not employee id)
ALTER TABLE "leave_approvals" ADD COLUMN "approverUserId" TEXT;

-- 7. LeaveRequest: half-day + approval-chain fields (Phase 2 item 6)
ALTER TABLE "leave_requests" ADD COLUMN "halfDay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "leave_requests" ADD COLUMN "halfDayPeriod" TEXT;
ALTER TABLE "leave_requests" ADD COLUMN "approvalChain" JSONB;
ALTER TABLE "leave_requests" ADD COLUMN "currentStep" INTEGER NOT NULL DEFAULT 0;

-- 8. LeavePolicy (Phase 2 item 6)
CREATE TABLE "leave_policies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leaveTypeId" TEXT NOT NULL UNIQUE REFERENCES "leave_types"("id") ON DELETE CASCADE,
    "accrualPerMonth" DECIMAL(5,2),
    "carryOverCap" DECIMAL(5,1),
    "workingDays" INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
    "maxConsecutiveDays" INTEGER,
    "requiresHrApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 9-10. LeaveStatus: add DRAFT (AI assistant safe action drafts leave requests)
--     AuditAction: add READ, DOCUMENT_DOWNLOAD
-- MOVED OUT OF THIS MIGRATION (go-live Phase 1 item 1): PostgreSQL forbids
-- ALTER TYPE ... ADD VALUE inside a transaction block, and `migrate deploy`
-- wraps every migration in one — these statements fail there. They are
-- applied OUTSIDE the migration transaction by scripts/apply-enum-values.sql
-- (idempotent; the deploy pipeline runs it before `migrate deploy`).
-- The schema.prisma enums already declare these values, so the Prisma client
-- is unchanged by this move.

-- 11. Employee extended profile (Phase 2 items 3 & 5)
ALTER TABLE "employees" ADD COLUMN "timezone" TEXT;
ALTER TABLE "employees" ADD COLUMN "emergencyContact" JSONB;
ALTER TABLE "employees" ADD COLUMN "contractStart" TIMESTAMPTZ(6);
ALTER TABLE "employees" ADD COLUMN "contractEnd" TIMESTAMPTZ(6);
ALTER TABLE "employees" ADD COLUMN "workLocation" TEXT;
ALTER TABLE "employees" ADD COLUMN "bankAccountEnc" TEXT;
ALTER TABLE "employees" ADD COLUMN "taxIdEnc" TEXT;
ALTER TABLE "employees" ADD COLUMN "terminationDate" TIMESTAMPTZ(6);

-- 12. AttendanceRecord: breaks + overtime (Phase 2 item 5)
ALTER TABLE "attendance_records" ADD COLUMN "breakMinutes" INTEGER;
ALTER TABLE "attendance_records" ADD COLUMN "overtimeMinutes" INTEGER;

-- 13. AttendanceCorrection (Phase 2 item 5; service currently uses a
--     documented Redis interim store — repoint to this table as a follow-up)
CREATE TYPE "CorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TABLE "attendance_corrections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attendanceRecordId" TEXT NOT NULL REFERENCES "attendance_records"("id") ON DELETE CASCADE,
    "employeeId" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
    "requestedClockIn" TIMESTAMPTZ(6),
    "requestedClockOut" TIMESTAMPTZ(6),
    "reason" TEXT NOT NULL,
    "status" "CorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "attendance_corrections_employeeId_status_idx" ON "attendance_corrections"("employeeId", "status");

-- 14. ReviewForm (Phase 2 item 9)
CREATE TABLE "review_forms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sections" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 15. Onboarding / offboarding (Phase 3 item 6)
CREATE TYPE "OnboardingKind" AS ENUM ('ONBOARDING', 'OFFBOARDING');
CREATE TYPE "ChecklistStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');
CREATE TABLE "onboarding_checklists" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
    "kind" "OnboardingKind" NOT NULL,
    "status" "ChecklistStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "referenceDate" TIMESTAMPTZ(6),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "onboarding_checklists_employeeId_kind_idx" ON "onboarding_checklists"("employeeId", "kind");
CREATE TABLE "onboarding_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checklistId" TEXT NOT NULL REFERENCES "onboarding_checklists"("id") ON DELETE CASCADE,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerRole" TEXT NOT NULL DEFAULT 'HR',
    "ownerUserId" TEXT,
    "dueDate" TIMESTAMPTZ(6),
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMPTZ(6),
    "completedById" TEXT,
    "note" TEXT,
    "documentId" TEXT REFERENCES "documents"("id") ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "onboarding_tasks_checklistId_status_idx" ON "onboarding_tasks"("checklistId", "status");

-- 16. Recruitment pipeline (Phase 3 item 8)
CREATE TYPE "VacancyStatus" AS ENUM ('OPEN', 'ON_HOLD', 'CLOSED');
CREATE TYPE "CandidateStage" AS ENUM ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');
CREATE TABLE "vacancies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT REFERENCES "departments"("id") ON DELETE SET NULL,
    "designationId" TEXT REFERENCES "designations"("id") ON DELETE SET NULL,
    "status" "VacancyStatus" NOT NULL DEFAULT 'OPEN',
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "closedAt" TIMESTAMPTZ(6),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vacancyId" TEXT NOT NULL REFERENCES "vacancies"("id") ON DELETE CASCADE,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "resumeDocumentId" TEXT REFERENCES "documents"("id") ON DELETE SET NULL,
    "stage" "CandidateStage" NOT NULL DEFAULT 'APPLIED',
    "notes" JSONB NOT NULL DEFAULT '[]',
    "employeeId" TEXT REFERENCES "employees"("id") ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "candidates_vacancyId_stage_idx" ON "candidates"("vacancyId", "stage");
CREATE TABLE "offers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMPTZ(6),
    "salaryAmount" DECIMAL(14,2),
    "terms" TEXT,
    "sentAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- 17. PushSubscription (Phase 3 item 7 — replaces the documented Redis interim)
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    CONSTRAINT "push_subscriptions_userId_endpoint_key" UNIQUE ("userId", "endpoint")
);

-- 18. PayrollRun.currency (multi-entity payroll reporting)
ALTER TABLE "payroll_runs" ADD COLUMN "currency" TEXT;
