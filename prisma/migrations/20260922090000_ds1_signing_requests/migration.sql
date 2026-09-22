-- DS-1 (Digio eSign, 22 Sep 2026): e-signature requests beside the click
-- acceptances, and the three kinds the five documents need. Written by hand.

ALTER TYPE "AgreementKind" ADD VALUE 'EMPLOYEE_APPOINTMENT';
ALTER TYPE "AgreementKind" ADD VALUE 'PRINT_PARTNER_SERVICE';
ALTER TYPE "AgreementKind" ADD VALUE 'PUBLISHER_LICENCE';

CREATE TYPE "SigningParty" AS ENUM ('PUBLISHER', 'ADVERTISER', 'AGENT', 'EMPLOYEE', 'PRINT_PARTNER');
CREATE TYPE "SigningStatus" AS ENUM ('REQUESTED', 'PARTIALLY_SIGNED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED');
CREATE TYPE "SignMethod" AS ENUM ('AADHAAR', 'DSC', 'ELECTRONIC');

CREATE TABLE "SigningRequest" (
    "id" TEXT NOT NULL,
    "kind" "AgreementKind" NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "partyType" "SigningParty" NOT NULL,
    "partyId" TEXT NOT NULL,
    "signerUserId" TEXT,
    "signerName" TEXT NOT NULL,
    "signerIdentifier" TEXT NOT NULL,
    "signMethod" "SignMethod" NOT NULL DEFAULT 'AADHAAR',
    "campaignId" TEXT,
    "attemptId" TEXT,
    "status" "SigningStatus" NOT NULL DEFAULT 'REQUESTED',
    "provider" "SignatureProvider" NOT NULL DEFAULT 'DIGIO',
    "providerRef" TEXT,
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "signers" JSONB NOT NULL,
    "signingUrl" TEXT,
    "renderedDocument" TEXT NOT NULL,
    "documentFileId" TEXT,
    "signedFileId" TEXT,
    "certificateFileId" TEXT,
    "stampState" TEXT,
    "stampAmount" DECIMAL(12,2),
    "stampRef" TEXT,
    "countersign" BOOLEAN NOT NULL DEFAULT false,
    "followUp" JSONB,
    "providerPayload" JSONB,
    "acceptanceId" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastReminderAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SigningRequest_providerRef_key" ON "SigningRequest"("providerRef");
CREATE UNIQUE INDEX "SigningRequest_acceptanceId_key" ON "SigningRequest"("acceptanceId");
CREATE INDEX "SigningRequest_partyType_partyId_kind_idx" ON "SigningRequest"("partyType", "partyId", "kind");
CREATE INDEX "SigningRequest_kind_status_idx" ON "SigningRequest"("kind", "status");
CREATE INDEX "SigningRequest_status_expiresAt_idx" ON "SigningRequest"("status", "expiresAt");
CREATE INDEX "SigningRequest_campaignId_idx" ON "SigningRequest"("campaignId");

ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgreementTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_acceptanceId_fkey" FOREIGN KEY ("acceptanceId") REFERENCES "AgreementAcceptance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
