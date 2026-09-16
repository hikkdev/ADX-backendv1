-- DR 07 wave 3: disputes. One domain for three personas and the console.
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE';
ALTER TYPE "PartyType" ADD VALUE 'DISPUTE';

CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'REJECTED');
CREATE TYPE "DisputeReason" AS ENUM ('PROOF_REJECTED', 'PAYOUT_ISSUE', 'DAMAGE', 'WRONG_LOCATION', 'OTHER');
CREATE TYPE "DisputeParty" AS ENUM ('PUBLISHER', 'ADVERTISER', 'AGENT', 'ADX');
CREATE TYPE "DisputeOutcome" AS ENUM ('REINSTALL', 'PARTIAL_CREDIT', 'FULL_CREDIT', 'NO_FAULT');
CREATE TYPE "DisputeCreditStatus" AS ENUM ('NONE', 'PENDING', 'RELEASED');

CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "raisedAs" "DisputeParty" NOT NULL,
    "againstParty" "DisputeParty" NOT NULL,
    "againstUserId" TEXT,
    "orderId" TEXT,
    "listingId" TEXT,
    "reason" "DisputeReason" NOT NULL,
    "detail" TEXT NOT NULL,
    "expectedResolution" TEXT,
    "amountClaimed" DECIMAL(14,2),
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "statusNote" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "reviewStartedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "outcome" "DisputeOutcome",
    "resolutionNote" TEXT,
    "creditedAmount" DECIMAL(14,2),
    "creditStatus" "DisputeCreditStatus" NOT NULL DEFAULT 'NONE',
    "creditReleasedAt" TIMESTAMP(3),
    "creditReleasedById" TEXT,
    "creditWalletEntryId" TEXT,
    "reopenUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisputeMessage" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "isFromOps" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisputeEvidence" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'IMG',
    "fileName" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Dispute_displayId_key" ON "Dispute"("displayId");
CREATE INDEX "Dispute_raisedByUserId_createdAt_idx" ON "Dispute"("raisedByUserId", "createdAt");
CREATE INDEX "Dispute_againstUserId_idx" ON "Dispute"("againstUserId");
CREATE INDEX "Dispute_status_createdAt_idx" ON "Dispute"("status", "createdAt");
CREATE INDEX "Dispute_orderId_idx" ON "Dispute"("orderId");
CREATE INDEX "DisputeMessage_disputeId_createdAt_idx" ON "DisputeMessage"("disputeId", "createdAt");
CREATE INDEX "DisputeEvidence_disputeId_idx" ON "DisputeEvidence"("disputeId");

ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_raisedByUserId_fkey" FOREIGN KEY ("raisedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeEvidence" ADD CONSTRAINT "DisputeEvidence_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DisputeEvidence" ADD CONSTRAINT "DisputeEvidence_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
