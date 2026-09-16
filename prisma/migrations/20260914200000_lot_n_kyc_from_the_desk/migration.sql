-- Lot N: KYC for print partners; KYC requested from the desk and recorded at the desk.
ALTER TYPE "KycPartyType" ADD VALUE 'PRINT_PARTNER';

ALTER TABLE "PublisherKyc" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "PublisherKyc" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "PublisherKyc" ADD COLUMN "requestedChannel" TEXT;
ALTER TABLE "PublisherKyc" ADD COLUMN "recordedById" TEXT;
ALTER TABLE "PublisherKyc" ADD COLUMN "recordedVia" TEXT;

ALTER TABLE "AdvertiserKyc" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "AdvertiserKyc" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "requestedChannel" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "recordedById" TEXT;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "recordedVia" TEXT;

ALTER TABLE "UserKyc" ADD COLUMN "attestedById" TEXT;
ALTER TABLE "UserKyc" ADD COLUMN "attestedAt" TIMESTAMP(3);
ALTER TABLE "UserKyc" ADD COLUMN "attestationNote" TEXT;

ALTER TABLE "PrintPartner" ADD COLUMN "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING';

CREATE TABLE "PrintPartnerKyc" (
  "id" TEXT NOT NULL,
  "printPartnerId" TEXT NOT NULL,
  "manifestVersion" INTEGER,
  "panNumber" TEXT,
  "panFrontUrl" TEXT,
  "panSignatureUrl" TEXT,
  "gstUrl" TEXT,
  "businessRegCertUrl" TEXT,
  "businessAddressProofUrl" TEXT,
  "directorIdUrl" TEXT,
  "govIdType" TEXT,
  "govIdFrontUrl" TEXT,
  "govIdBackUrl" TEXT,
  "bankProofUrl" TEXT,
  "selfieUrl" TEXT,
  "digioRequestId" TEXT,
  "digioReferenceId" TEXT,
  "digioStatus" TEXT,
  "digioVerifiedAt" TIMESTAMP(3),
  "digioPayload" JSONB,
  "method" TEXT NOT NULL DEFAULT 'MANUAL',
  "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
  "rejectionReason" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewNote" TEXT,
  "assignedToId" TEXT,
  "assignedAt" TIMESTAMP(3),
  "escalatedAt" TIMESTAMP(3),
  "escalationSource" "KycEscalationSource",
  "escalationReason" TEXT,
  "escalatedToUserId" TEXT,
  "escalatedById" TEXT,
  "imagesPurgedAt" TIMESTAMP(3),
  "requestedAt" TIMESTAMP(3),
  "requestedById" TEXT,
  "requestedChannel" TEXT,
  "recordedById" TEXT,
  "recordedVia" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintPartnerKyc_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintPartnerKyc_printPartnerId_key" ON "PrintPartnerKyc"("printPartnerId");
CREATE INDEX "PrintPartnerKyc_status_submittedAt_idx" ON "PrintPartnerKyc"("status", "submittedAt");
CREATE INDEX "PrintPartnerKyc_digioRequestId_idx" ON "PrintPartnerKyc"("digioRequestId");
ALTER TABLE "PrintPartnerKyc" ADD CONSTRAINT "PrintPartnerKyc_printPartnerId_fkey" FOREIGN KEY ("printPartnerId") REFERENCES "PrintPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
