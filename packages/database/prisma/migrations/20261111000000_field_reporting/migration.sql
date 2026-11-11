-- CreateEnum
CREATE TYPE "FieldReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FieldReportCategory" AS ENUM ('SITE_INSPECTION', 'INCIDENT_SAFETY', 'CLIENT_VISIT', 'EQUIPMENT_AUDIT', 'DELIVERY_VERIFICATION', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "FieldMediaKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "FieldMediaScanStatus" AS ENUM ('PENDING_SCAN', 'CLEAN', 'INFECTED', 'SCAN_FAILED');

-- CreateEnum
CREATE TYPE "FieldMediaProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FieldReportDerivativeKind" AS ENUM ('THUMBNAIL', 'WEB_PREVIEW', 'RESIZED_STANDARD');

-- CreateEnum
CREATE TYPE "FieldReportDownloadVariant" AS ENUM ('ORIGINAL', 'RESIZED');

-- CreateEnum
CREATE TYPE "FieldReportReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CHANGES');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('OPEN', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "field_reports" (
    "id" TEXT NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "entityId" TEXT,
    "siteId" TEXT,
    "category" "FieldReportCategory" NOT NULL DEFAULT 'SITE_INSPECTION',
    "status" "FieldReportStatus" NOT NULL DEFAULT 'DRAFT',
    "currentRevisionNumber" INTEGER NOT NULL DEFAULT 1,
    "currentRevisionId" TEXT,
    "latestSubmittedAt" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "retentionExpiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_revisions" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" "FieldReportStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "siteId" TEXT,
    "gpsConsentGranted" BOOLEAN NOT NULL DEFAULT false,
    "gpsConsentAt" TIMESTAMP(3),
    "gpsConsentPolicyVersion" TEXT,
    "gpsLatitude" DECIMAL(9,6),
    "gpsLongitude" DECIMAL(9,6),
    "gpsAccuracyMeters" DOUBLE PRECISION,
    "gpsCapturedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "submittedManagerSnapshotId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewDecisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_report_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_attachments" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clientCaptureId" TEXT,
    "mediaKind" "FieldMediaKind" NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "encryptionScheme" TEXT NOT NULL DEFAULT 'CHUNKED_GCM_V1',
    "iv" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL DEFAULT 262144,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "exifOrientation" INTEGER,
    "hasEmbeddedGps" BOOLEAN,
    "scanStatus" "FieldMediaScanStatus" NOT NULL DEFAULT 'PENDING_SCAN',
    "scannerName" TEXT,
    "scanThreats" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scannedAt" TIMESTAMP(3),
    "processingStatus" "FieldMediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "processingErrorCode" TEXT,
    "processingErrorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_report_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_revision_attachments" (
    "revisionId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT,
    "addedInRevisionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_report_revision_attachments_pkey" PRIMARY KEY ("revisionId","attachmentId")
);

-- CreateTable
CREATE TABLE "field_report_derivatives" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "kind" "FieldReportDerivativeKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "encryptionScheme" TEXT NOT NULL DEFAULT 'CHUNKED_GCM_V1',
    "iv" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL DEFAULT 262144,
    "metadataStripped" BOOLEAN NOT NULL DEFAULT true,
    "colorspace" TEXT NOT NULL DEFAULT 'srgb',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_report_derivatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_reviews" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "reviewerEmployeeId" TEXT,
    "actedAsDelegateForId" TEXT,
    "decision" "FieldReportReviewDecision" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_report_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_comments" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionId" TEXT,
    "authorUserId" TEXT NOT NULL,
    "authorEmployeeId" TEXT,
    "actedAsDelegateForId" TEXT,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_report_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_policies" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "roleName" TEXT,
    "defaultDownloadVariant" "FieldReportDownloadVariant" NOT NULL DEFAULT 'RESIZED',
    "allowOriginalDownload" BOOLEAN NOT NULL DEFAULT true,
    "retentionDaysOverride" INTEGER,
    "requireGpsForCategories" "FieldReportCategory"[] DEFAULT ARRAY[]::"FieldReportCategory"[],
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_report_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_delegations" (
    "id" TEXT NOT NULL,
    "delegatorEmployeeId" TEXT NOT NULL,
    "delegateEmployeeId" TEXT NOT NULL,
    "entityId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_report_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_report_upload_sessions" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clientCaptureId" TEXT,
    "originalFileName" TEXT NOT NULL,
    "claimedMimeType" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "declaredSha256" TEXT,
    "chunkSizeBytes" INTEGER NOT NULL,
    "totalChunks" INTEGER NOT NULL,
    "uploadedChunks" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "stagingKeyPrefix" TEXT NOT NULL,
    "stagingKeyEnc" TEXT NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_report_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "field_reports_reportNumber_key" ON "field_reports"("reportNumber");

-- CreateIndex
CREATE UNIQUE INDEX "field_reports_currentRevisionId_key" ON "field_reports"("currentRevisionId");

-- CreateIndex
CREATE INDEX "field_reports_employeeId_status_deletedAt_idx" ON "field_reports"("employeeId", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "field_reports_entityId_status_createdAt_idx" ON "field_reports"("entityId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "field_reports_siteId_createdAt_idx" ON "field_reports"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "field_reports_category_status_idx" ON "field_reports"("category", "status");

-- CreateIndex
CREATE INDEX "field_reports_deletedAt_retentionExpiresAt_idx" ON "field_reports"("deletedAt", "retentionExpiresAt");

-- CreateIndex
CREATE INDEX "field_report_revisions_status_submittedAt_idx" ON "field_report_revisions"("status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_revisions_reportId_revisionNumber_key" ON "field_report_revisions"("reportId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_attachments_storageKey_key" ON "field_report_attachments"("storageKey");

-- CreateIndex
CREATE INDEX "field_report_attachments_reportId_deletedAt_idx" ON "field_report_attachments"("reportId", "deletedAt");

-- CreateIndex
CREATE INDEX "field_report_attachments_employeeId_deletedAt_idx" ON "field_report_attachments"("employeeId", "deletedAt");

-- CreateIndex
CREATE INDEX "field_report_attachments_scanStatus_processingStatus_idx" ON "field_report_attachments"("scanStatus", "processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_attachments_reportId_clientCaptureId_key" ON "field_report_attachments"("reportId", "clientCaptureId");

-- CreateIndex
CREATE INDEX "field_report_revision_attachments_attachmentId_idx" ON "field_report_revision_attachments"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_derivatives_storageKey_key" ON "field_report_derivatives"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_derivatives_attachmentId_kind_key" ON "field_report_derivatives"("attachmentId", "kind");

-- CreateIndex
CREATE INDEX "field_report_reviews_reportId_createdAt_idx" ON "field_report_reviews"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "field_report_reviews_revisionId_idx" ON "field_report_reviews"("revisionId");

-- CreateIndex
CREATE INDEX "field_report_reviews_reviewerUserId_idx" ON "field_report_reviews"("reviewerUserId");

-- CreateIndex
CREATE INDEX "field_report_comments_reportId_deletedAt_createdAt_idx" ON "field_report_comments"("reportId", "deletedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_policies_entityId_roleName_key" ON "field_report_policies"("entityId", "roleName");

-- CreateIndex
CREATE INDEX "field_report_delegations_delegateEmployeeId_isActive_starts_idx" ON "field_report_delegations"("delegateEmployeeId", "isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "field_report_delegations_delegatorEmployeeId_isActive_idx" ON "field_report_delegations"("delegatorEmployeeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "field_report_upload_sessions_stagingKeyPrefix_key" ON "field_report_upload_sessions"("stagingKeyPrefix");

-- CreateIndex
CREATE INDEX "field_report_upload_sessions_status_expiresAt_idx" ON "field_report_upload_sessions"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "field_report_upload_sessions_revisionId_uploadedByUserId_idx" ON "field_report_upload_sessions"("revisionId", "uploadedByUserId");

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "field_report_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_revisions" ADD CONSTRAINT "field_report_revisions_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "field_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_revisions" ADD CONSTRAINT "field_report_revisions_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_revisions" ADD CONSTRAINT "field_report_revisions_submittedManagerSnapshotId_fkey" FOREIGN KEY ("submittedManagerSnapshotId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_attachments" ADD CONSTRAINT "field_report_attachments_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "field_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_attachments" ADD CONSTRAINT "field_report_attachments_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_attachments" ADD CONSTRAINT "field_report_attachments_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_revision_attachments" ADD CONSTRAINT "field_report_revision_attachments_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "field_report_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_revision_attachments" ADD CONSTRAINT "field_report_revision_attachments_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "field_report_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_derivatives" ADD CONSTRAINT "field_report_derivatives_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "field_report_attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_reviews" ADD CONSTRAINT "field_report_reviews_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "field_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_reviews" ADD CONSTRAINT "field_report_reviews_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "field_report_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_reviews" ADD CONSTRAINT "field_report_reviews_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_reviews" ADD CONSTRAINT "field_report_reviews_reviewerEmployeeId_fkey" FOREIGN KEY ("reviewerEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_reviews" ADD CONSTRAINT "field_report_reviews_actedAsDelegateForId_fkey" FOREIGN KEY ("actedAsDelegateForId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_comments" ADD CONSTRAINT "field_report_comments_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "field_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_comments" ADD CONSTRAINT "field_report_comments_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "field_report_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_comments" ADD CONSTRAINT "field_report_comments_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_comments" ADD CONSTRAINT "field_report_comments_authorEmployeeId_fkey" FOREIGN KEY ("authorEmployeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_policies" ADD CONSTRAINT "field_report_policies_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_delegations" ADD CONSTRAINT "field_report_delegations_delegatorEmployeeId_fkey" FOREIGN KEY ("delegatorEmployeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_delegations" ADD CONSTRAINT "field_report_delegations_delegateEmployeeId_fkey" FOREIGN KEY ("delegateEmployeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_upload_sessions" ADD CONSTRAINT "field_report_upload_sessions_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "field_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_report_upload_sessions" ADD CONSTRAINT "field_report_upload_sessions_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "field_report_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Custom Field Reporting database hardening, sequence, triggers & idempotent seed
-- =============================================================================

-- 1. Human-readable sequential report numbers (FR-YYYY-NNNN)
CREATE SEQUENCE IF NOT EXISTS "field_report_number_seq" START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

-- 2. Partial unique indexes for nullable policy specificity
CREATE UNIQUE INDEX IF NOT EXISTS "field_report_policies_global_default_uidx"
  ON "field_report_policies"((1)) WHERE "entityId" IS NULL AND "roleName" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "field_report_policies_entity_default_uidx"
  ON "field_report_policies"("entityId") WHERE "roleName" IS NULL AND "entityId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "field_report_policies_role_default_uidx"
  ON "field_report_policies"("roleName") WHERE "entityId" IS NULL AND "roleName" IS NOT NULL;

-- 3. Defense-in-depth immutability trigger on submitted revisions & their attachment links
CREATE OR REPLACE FUNCTION enforce_field_report_revision_immutability()
RETURNS TRIGGER AS $$
DECLARE
  rev_locked_at TIMESTAMPTZ;
BEGIN
  IF current_setting('ems.gdpr_erasure', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'field_report_revisions' THEN
    IF OLD."lockedAt" IS NOT NULL THEN
      IF NEW."reportId" IS DISTINCT FROM OLD."reportId"
         OR NEW."revisionNumber" IS DISTINCT FROM OLD."revisionNumber"
         OR NEW."title" IS DISTINCT FROM OLD."title"
         OR NEW."notes" IS DISTINCT FROM OLD."notes"
         OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
         OR NEW."siteId" IS DISTINCT FROM OLD."siteId"
         OR NEW."gpsConsentGranted" IS DISTINCT FROM OLD."gpsConsentGranted"
         OR NEW."gpsConsentAt" IS DISTINCT FROM OLD."gpsConsentAt"
         OR NEW."gpsLatitude" IS DISTINCT FROM OLD."gpsLatitude"
         OR NEW."gpsLongitude" IS DISTINCT FROM OLD."gpsLongitude"
         OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
         OR NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt" THEN
        RAISE EXCEPTION 'Submitted field report revision % is immutable', OLD."id";
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'field_report_revision_attachments' THEN
    SELECT "lockedAt" INTO rev_locked_at
      FROM "field_report_revisions"
      WHERE "id" = COALESCE(NEW."revisionId", OLD."revisionId");
    IF rev_locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot mutate attachments on locked field report revision';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_field_report_revisions_immutable"
  BEFORE UPDATE ON "field_report_revisions"
  FOR EACH ROW EXECUTE FUNCTION enforce_field_report_revision_immutability();

CREATE TRIGGER "trg_field_report_revision_attachments_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "field_report_revision_attachments"
  FOR EACH ROW EXECUTE FUNCTION enforce_field_report_revision_immutability();

-- 4. Idempotent production permission & role backfill (excluding AUDITOR intentionally)
INSERT INTO "permissions" ("id", "subject", "action", "description")
VALUES
  (gen_random_uuid()::text, 'FIELD_REPORT', 'CREATE', 'Create draft field reports and upload media'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'READ', 'View authorized field reports and previews'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'UPDATE', 'Edit draft field report metadata'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'DELETE', 'Soft-delete draft or permitted field reports'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'REVIEW', 'Review, comment, approve, reject, or request changes'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'DOWNLOAD_ORIGINAL', 'Download bit-exact full-resolution Original media'),
  (gen_random_uuid()::text, 'FIELD_REPORT', 'MANAGE', 'Manage field report policies, legal holds, and cross-team delegations')
ON CONFLICT ("action", "subject") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."subject" = 'FIELD_REPORT'
WHERE (r."name"::text IN ('SUPER_ADMIN', 'HR_ADMIN'))
   OR (r."name"::text = 'MANAGER'  AND p."action" IN ('CREATE', 'READ', 'UPDATE', 'REVIEW', 'DOWNLOAD_ORIGINAL'))
   OR (r."name"::text = 'EMPLOYEE' AND p."action" IN ('CREATE', 'READ', 'UPDATE', 'DELETE'))
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Default org & per-role download policy rows
INSERT INTO "field_report_policies" ("id", "entityId", "roleName", "defaultDownloadVariant", "allowOriginalDownload", "updatedAt")
VALUES
  (gen_random_uuid()::text, NULL, NULL,          'RESIZED',  true,  CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, NULL, 'EMPLOYEE',    'RESIZED',  false, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, NULL, 'MANAGER',     'RESIZED',  true,  CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, NULL, 'HR_ADMIN',    'ORIGINAL', true,  CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, NULL, 'SUPER_ADMIN', 'ORIGINAL', true,  CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

