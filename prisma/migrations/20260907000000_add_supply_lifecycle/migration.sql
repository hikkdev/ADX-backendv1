-- Publisher supply lifecycle: agreements, listing attempts, documents,
-- verification, claims, compliance cases and earnings holds.
-- See docs/publisher-supply-lifecycle.md.
--
-- ListingStatus gains values rather than being recreated, so existing rows
-- are untouched. No new value is used in this transaction, which keeps
-- ALTER TYPE ... ADD VALUE legal inside the migration transaction.

-- CreateEnum
CREATE TYPE "AgreementKind" AS ENUM ('PLATFORM', 'LISTING');

-- CreateEnum
CREATE TYPE "ListingAttemptOrigin" AS ENUM ('SELF', 'AGENT', 'ADMIN_SINGLE', 'ADMIN_BULK', 'SCRAPE');

-- CreateEnum
CREATE TYPE "ListingAttemptStatus" AS ENUM ('DRAFT', 'AWAITING_ACCEPTANCE', 'ACCEPTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ListingRemovability" AS ENUM ('PERMANENT', 'REMOVABLE');

-- CreateEnum
CREATE TYPE "ListingDocumentKind" AS ENUM ('DISPLAY_AGREEMENT', 'OWNER_NOC', 'ADDRESS_PROOF', 'MUNICIPAL_PERMIT', 'OTHER');

-- CreateEnum
CREATE TYPE "ListingDocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('AGENT_INITIAL', 'SELF_REVERIFICATION');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ListingClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ComplianceCaseReason" AS ENUM ('VERIFICATION_LAPSED');

-- CreateEnum
CREATE TYPE "ComplianceCaseStatus" AS ENUM ('OPEN', 'CONTACTED', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ContactAttemptChannel" AS ENUM ('CALL', 'SMS', 'EMAIL', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "EarningsHoldStatus" AS ENUM ('HELD', 'RELEASED', 'FORFEITED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ListingStatus" ADD VALUE 'UNCLAIMED';
ALTER TYPE "ListingStatus" ADD VALUE 'AWAITING_AGREEMENT';
ALTER TYPE "ListingStatus" ADD VALUE 'AWAITING_DOCUMENTS';
ALTER TYPE "ListingStatus" ADD VALUE 'AWAITING_SITE_VERIFICATION';
ALTER TYPE "ListingStatus" ADD VALUE 'SUSPENDED';

-- DropForeignKey
ALTER TABLE "Listing" DROP CONSTRAINT "Listing_publisherId_fkey";

-- DropForeignKey
ALTER TABLE "Listing" DROP CONSTRAINT "Listing_agentId_fkey";

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "isPartnerPublisher" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "attemptId" TEXT,
ADD COLUMN     "documentsClearedAt" TIMESTAMP(3),
ADD COLUMN     "removability" "ListingRemovability" NOT NULL DEFAULT 'PERMANENT',
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ALTER COLUMN "publisherId" DROP NOT NULL,
ALTER COLUMN "agentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AgreementTemplate" (
    "id" TEXT NOT NULL,
    "kind" "AgreementKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgreementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementAcceptance" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateKind" "AgreementKind" NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "publisherId" TEXT NOT NULL,
    "attemptId" TEXT,
    "acceptedByUserId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "renderedDocument" TEXT,

    CONSTRAINT "AgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingAttempt" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT,
    "origin" "ListingAttemptOrigin" NOT NULL,
    "status" "ListingAttemptStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "sourceFilename" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingDocument" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "kind" "ListingDocumentKind" NOT NULL,
    "url" TEXT NOT NULL,
    "status" "ListingDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,

    CONSTRAINT "ListingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingVerification" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "type" "VerificationType" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "photoUrl" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "distanceMeters" DOUBLE PRECISION,
    "qrScanned" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "submittedByUserId" TEXT,
    "orderId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingClaim" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "claimantPublisherId" TEXT NOT NULL,
    "status" "ListingClaimStatus" NOT NULL DEFAULT 'PENDING',
    "evidenceNote" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceCase" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "publisherId" TEXT,
    "reason" "ComplianceCaseReason" NOT NULL,
    "status" "ComplianceCaseStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "assignedToUserId" TEXT,

    CONSTRAINT "ComplianceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceContactAttempt" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "channel" "ContactAttemptChannel" NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedByUserId" TEXT,

    CONSTRAINT "ComplianceContactAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningsHold" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "EarningsHoldStatus" NOT NULL DEFAULT 'HELD',
    "heldFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convertsAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "forfeitedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "EarningsHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgreementTemplate_kind_isActive_idx" ON "AgreementTemplate"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementTemplate_kind_version_key" ON "AgreementTemplate"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementAcceptance_attemptId_key" ON "AgreementAcceptance"("attemptId");

-- CreateIndex
CREATE INDEX "AgreementAcceptance_publisherId_templateKind_idx" ON "AgreementAcceptance"("publisherId", "templateKind");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementAcceptance_publisherId_templateId_key" ON "AgreementAcceptance"("publisherId", "templateId");

-- CreateIndex
CREATE INDEX "ListingAttempt_publisherId_status_idx" ON "ListingAttempt"("publisherId", "status");

-- CreateIndex
CREATE INDEX "ListingAttempt_status_createdAt_idx" ON "ListingAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ListingDocument_listingId_status_idx" ON "ListingDocument"("listingId", "status");

-- CreateIndex
CREATE INDEX "ListingDocument_status_submittedAt_idx" ON "ListingDocument"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ListingVerification_listingId_createdAt_idx" ON "ListingVerification"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "ListingVerification_status_idx" ON "ListingVerification"("status");

-- CreateIndex
CREATE INDEX "ListingClaim_status_createdAt_idx" ON "ListingClaim"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ListingClaim_listingId_claimantPublisherId_key" ON "ListingClaim"("listingId", "claimantPublisherId");

-- CreateIndex
CREATE INDEX "ComplianceCase_status_dueAt_idx" ON "ComplianceCase"("status", "dueAt");

-- CreateIndex
CREATE INDEX "ComplianceCase_listingId_idx" ON "ComplianceCase"("listingId");

-- CreateIndex
CREATE INDEX "ComplianceContactAttempt_caseId_attemptedAt_idx" ON "ComplianceContactAttempt"("caseId", "attemptedAt");

-- CreateIndex
CREATE INDEX "EarningsHold_status_convertsAt_idx" ON "EarningsHold"("status", "convertsAt");

-- CreateIndex
CREATE INDEX "EarningsHold_listingId_idx" ON "EarningsHold"("listingId");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ListingAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgreementTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ListingAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAttempt" ADD CONSTRAINT "ListingAttempt_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAttempt" ADD CONSTRAINT "ListingAttempt_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingDocument" ADD CONSTRAINT "ListingDocument_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingDocument" ADD CONSTRAINT "ListingDocument_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVerification" ADD CONSTRAINT "ListingVerification_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVerification" ADD CONSTRAINT "ListingVerification_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingVerification" ADD CONSTRAINT "ListingVerification_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingClaim" ADD CONSTRAINT "ListingClaim_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingClaim" ADD CONSTRAINT "ListingClaim_claimantPublisherId_fkey" FOREIGN KEY ("claimantPublisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingClaim" ADD CONSTRAINT "ListingClaim_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCase" ADD CONSTRAINT "ComplianceCase_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceContactAttempt" ADD CONSTRAINT "ComplianceContactAttempt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ComplianceCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceContactAttempt" ADD CONSTRAINT "ComplianceContactAttempt_attemptedByUserId_fkey" FOREIGN KEY ("attemptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningsHold" ADD CONSTRAINT "EarningsHold_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningsHold" ADD CONSTRAINT "EarningsHold_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

