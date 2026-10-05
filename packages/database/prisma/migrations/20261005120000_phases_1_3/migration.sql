-- Phases 1-3 schema: audit chain hardening, employee-number sequence,
-- document keyId, multi-entity, MFA, invitations, OAuth accounts.
--
-- Hand-authored per repo convention (see BUILD_SPEC.md: Prisma migrations for
-- every schema change; never `db push` outside local dev).

-- ============================================================================
-- 1. Employee number sequence (Phase 1 refactoring).
--    Format EMP-YYYY-#### is produced in code (worker 2 owns the formatter);
--    services call nextval('employee_number_seq') instead of count()+1.
--    START WITH 1000: the dev seed already owns EMP-2026-0001..0020, so the
--    sequence starts well clear of seeded numbers. Assumption: production
--    employee numbers never need to reuse the 0001..0999 range.
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS "employee_number_seq" START WITH 1000;

-- ============================================================================
-- 2. AuditLog tamper-evidence hardening (Phase 1 security hardening).
--    `sequence`: gapless, unique chain position. Backfilled 1..N in
--    chronological order (createdAt, id). Assumption: hash-chain order is
--    chronological — uuid v4 ids carry no time order, so ordering by id alone
--    would scramble the chain; createdAt+id preserves it.
--    `scheme_version`: existing rows are v1; the API's audit service starts
--    v2 from a checkpoint row (worker 2). DEFAULT 1 keeps old writers valid.
-- ============================================================================
ALTER TABLE "audit_logs" ADD COLUMN "sequence" INTEGER;

UPDATE "audit_logs" AS a
SET "sequence" = sub.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn
  FROM "audit_logs"
) AS sub
WHERE a."id" = sub."id";

ALTER TABLE "audit_logs" ALTER COLUMN "sequence" SET NOT NULL;
CREATE UNIQUE INDEX "audit_logs_sequence_key" ON "audit_logs"("sequence");

ALTER TABLE "audit_logs" ADD COLUMN "schemeVersion" INTEGER NOT NULL DEFAULT 1;

-- ============================================================================
-- 3. Document.keyId (Phase 1: uploads — key-rotation procedure).
--    Identifies which encryption key envelope was used per object so keys can
--    be rotated without re-reading every row's history.
-- ============================================================================
ALTER TABLE "documents" ADD COLUMN "keyId" TEXT;

-- NOTE (Phase 1 refactoring): legacy "fileKey"/"fileUrl" columns are NOT
-- dropped here. documents.service.ts still mirrors the server-generated key
-- into "fileKey", and the GDPR export select-list references both columns.
-- Drop them only after the API stops reading/writing them.

-- ============================================================================
-- 4. Multi-entity & multi-location (Phase 3 item 1).
--    Entity: legal entity with its own currency, timezone, working week and
--    holiday calendar. Site: physical location under an entity.
--    entityId is nullable on all scoped tables for back-compat; existing rows
--    are backfilled to the default entity below.
--    Assumption: holidayCalendarId is an opaque external reference for now;
--    a first-class HolidayCalendar model is future work.
-- ============================================================================
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "workingWeek" JSONB NOT NULL DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}',
    "holidayCalendarId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sites_entityId_idx" ON "sites"("entityId");

ALTER TABLE "sites" ADD CONSTRAINT "sites_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Default entity: every pre-multi-entity row belongs here. Id is the stable
-- literal 'default' so seeds and backfills can reference it without a lookup.
INSERT INTO "entities" ("id", "name", "currency", "timezone", "workingWeek", "createdAt", "updatedAt")
VALUES ('default', 'Default Entity', 'GBP', 'Europe/London',
        '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":false,"sun":false}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "employees"      ADD COLUMN "entityId" TEXT;
ALTER TABLE "departments"    ADD COLUMN "entityId" TEXT;
ALTER TABLE "payroll_runs"   ADD COLUMN "entityId" TEXT;
ALTER TABLE "leave_requests" ADD COLUMN "entityId" TEXT;
ALTER TABLE "roster_entries" ADD COLUMN "entityId" TEXT;

UPDATE "employees"      SET "entityId" = 'default' WHERE "entityId" IS NULL;
UPDATE "departments"    SET "entityId" = 'default' WHERE "entityId" IS NULL;
UPDATE "payroll_runs"   SET "entityId" = 'default' WHERE "entityId" IS NULL;
UPDATE "leave_requests" SET "entityId" = 'default' WHERE "entityId" IS NULL;
UPDATE "roster_entries" SET "entityId" = 'default' WHERE "entityId" IS NULL;

CREATE INDEX "employees_entityId_idx"      ON "employees"("entityId");
CREATE INDEX "departments_entityId_idx"    ON "departments"("entityId");
CREATE INDEX "payroll_runs_entityId_idx"   ON "payroll_runs"("entityId");
CREATE INDEX "leave_requests_entityId_idx" ON "leave_requests"("entityId");
CREATE INDEX "roster_entries_entityId_idx" ON "roster_entries"("entityId");

ALTER TABLE "employees" ADD CONSTRAINT "employees_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "departments" ADD CONSTRAINT "departments_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 5. MFA (Phase 2 item 8; worker 1 owns the TOTP service).
--    mfaSecret: TOTP secret (encrypted by the API before storage).
--    mfaRecoveryHashes: sha256 hashes of single-use recovery codes, never
--    the codes themselves.
-- ============================================================================
ALTER TABLE "users" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "users" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "mfaRecoveryHashes" TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================================
-- 6. Invitation-based onboarding (Phase 1 B2; worker 1 owns the flow).
--    tokenHash: sha256 of the raw invite token; the raw token is emailed once
--    and never stored.
-- ============================================================================
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "SystemRole" NOT NULL,
    "employeeId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: PasswordResetToken already exists (baseline) with exactly the
-- required shape (id, userId FK, tokenHash UNIQUE, expiresAt, usedAt) — no
-- migration needed.

-- ============================================================================
-- 7. OAuth sign-in (Phase 3 item 5; worker 1 owns the flow).
--    Tokens are stored encrypted (accessTokenEnc/refreshTokenEnc); the API
--    must never log or return them.
-- ============================================================================
CREATE TABLE "oauth_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_accounts_providerUserId_key" ON "oauth_accounts"("providerUserId");
CREATE INDEX "oauth_accounts_userId_provider_idx" ON "oauth_accounts"("userId", "provider");

ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
