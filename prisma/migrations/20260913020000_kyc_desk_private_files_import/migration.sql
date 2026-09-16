-- Lot D (Q42/Q43/Q61/Q68/Q119/Q127/Q131): per-document KYC decisions and
-- flagged-only re-upload, private files, the liveness video, staff KYC, and the
-- publisher import that never verifies anyone.
ALTER TYPE "KycStatus" ADD VALUE 'NEEDS_INFO';
CREATE TYPE "KycDocumentDecision" AS ENUM ('APPROVED', 'FLAGGED');
CREATE TYPE "KycPartyType" AS ENUM ('PUBLISHER', 'ADVERTISER');
CREATE TYPE "UserKycPurpose" AS ENUM ('LIVENESS', 'OTHER');
CREATE TYPE "FileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "PublisherImportStatus" AS ENUM ('VALIDATED', 'COMMITTED', 'REVOKED');
CREATE TYPE "PublisherImportOutcome" AS ENUM ('CREATED', 'MERGED', 'SKIPPED', 'WARNING', 'INVALID');

CREATE TABLE "KycDocumentReview" (
  "id" TEXT NOT NULL,
  "partyType" "KycPartyType" NOT NULL,
  "kycId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "decision" "KycDocumentDecision" NOT NULL,
  "note" TEXT,
  "reviewedById" TEXT NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KycDocumentReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KycDocumentReview_partyType_kycId_field_key" ON "KycDocumentReview"("partyType", "kycId", "field");
CREATE INDEX "KycDocumentReview_kycId_idx" ON "KycDocumentReview"("kycId");

ALTER TABLE "PublisherKyc"
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "assignedToId" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "imagesPurgedAt" TIMESTAMP(3);
ALTER TABLE "AdvertiserKyc"
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "assignedToId" TEXT,
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "imagesPurgedAt" TIMESTAMP(3);

ALTER TABLE "UserKyc"
  ADD COLUMN "purpose" "UserKycPurpose" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "recordedById" TEXT;

ALTER TABLE "UploadedFile"
  ADD COLUMN "visibility" "FileVisibility" NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "ownerUserId" TEXT,
  ADD COLUMN "storageKey" TEXT;

CREATE TABLE "EmployeeKyc" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "govIdType" TEXT,
  "govIdFrontUrl" TEXT,
  "govIdBackUrl" TEXT,
  "panNumber" TEXT,
  "panFrontUrl" TEXT,
  "panSignatureUrl" TEXT,
  "addressProofType" TEXT,
  "addressProofUrl" TEXT,
  "selfieUrl" TEXT,
  "bankProofUrl" TEXT,
  "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
  "rejectionReason" TEXT,
  "recordedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeKyc_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeKyc_employeeId_key" ON "EmployeeKyc"("employeeId");
CREATE INDEX "EmployeeKyc_status_submittedAt_idx" ON "EmployeeKyc"("status", "submittedAt");
ALTER TABLE "EmployeeKyc" ADD CONSTRAINT "EmployeeKyc_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Employee" ADD COLUMN "externalHrmsId" TEXT;
CREATE UNIQUE INDEX "Employee_externalHrmsId_key" ON "Employee"("externalHrmsId");

CREATE TABLE "PublisherImport" (
  "id" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "note" TEXT,
  "uploadedById" TEXT NOT NULL,
  "status" "PublisherImportStatus" NOT NULL DEFAULT 'VALIDATED',
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "createdCount" INTEGER NOT NULL DEFAULT 0,
  "mergedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "invalidCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  CONSTRAINT "PublisherImport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PublisherImportRow" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  "outcome" "PublisherImportOutcome" NOT NULL,
  "publisherId" TEXT,
  "message" TEXT,
  CONSTRAINT "PublisherImportRow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PublisherImportRow_importId_rowNumber_idx" ON "PublisherImportRow"("importId", "rowNumber");
ALTER TABLE "PublisherImportRow" ADD CONSTRAINT "PublisherImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "PublisherImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
