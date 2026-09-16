-- Lot B (Q50): a print partner is a payee. The wallet's owner check grows a
-- fourth key; a job's approved cost is a PRINT_COST payable; the partner is a
-- 194C deductee like a publisher.
ALTER TYPE "TaxParty" ADD VALUE 'PARTNER';
ALTER TYPE "LedgerTransactionKind" ADD VALUE 'PRINT_COST';
CREATE TYPE "PrintJobStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'PRINTING', 'READY', 'COLLECTED', 'CANCELLED');

CREATE TABLE "PrintPartner" (
  "id" TEXT NOT NULL,
  "displayId" TEXT,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "legalName" TEXT,
  "gstin" TEXT,
  "panNumber" TEXT,
  "contactName" TEXT,
  "mobile" TEXT NOT NULL,
  "email" TEXT,
  "address" TEXT,
  "city" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maxWidthFt" DECIMAL(8,2),
  "turnaroundDays" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintPartner_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintPartner_displayId_key" ON "PrintPartner"("displayId");
CREATE UNIQUE INDEX "PrintPartner_userId_key" ON "PrintPartner"("userId");
CREATE INDEX "PrintPartner_city_isActive_idx" ON "PrintPartner"("city", "isActive");

CREATE TABLE "PrintJob" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "printPartnerId" TEXT NOT NULL,
  "status" "PrintJobStatus" NOT NULL DEFAULT 'REQUESTED',
  "quotedCost" DECIMAL(14,2),
  "actualCost" DECIMAL(14,2),
  "specs" JSONB,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  "collectedAt" TIMESTAMP(3),
  "costApprovedByUserId" TEXT,
  "costApprovedAt" TIMESTAMP(3),
  "ledgerTransactionId" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintJob_orderId_key" ON "PrintJob"("orderId");
CREATE INDEX "PrintJob_printPartnerId_status_idx" ON "PrintJob"("printPartnerId", "status");
ALTER TABLE "PrintJob"
  ADD CONSTRAINT "PrintJob_printPartnerId_fkey" FOREIGN KEY ("printPartnerId") REFERENCES "PrintPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Wallet" ADD COLUMN "printPartnerId" TEXT;
CREATE UNIQUE INDEX "Wallet_printPartnerId_key" ON "Wallet"("printPartnerId");
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_printPartnerId_fkey" FOREIGN KEY ("printPartnerId") REFERENCES "PrintPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_exactly_one_owner";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_exactly_one_owner" CHECK (
  (("advertiserId" IS NOT NULL)::int
   + ("publisherId" IS NOT NULL)::int
   + ("agentId" IS NOT NULL)::int
   + ("printPartnerId" IS NOT NULL)::int) = 1
);

-- 194C for partners, at zero until finance sets it — the same note the
-- publisher and agent rows carry.
INSERT INTO "TaxWithholdingRate" ("id", "appliesTo", "section", "ratePct", "effectiveFrom", "note", "createdAt")
SELECT 'tds_partner_194c_seed', 'PARTNER', '194C', 0.00, '2026-01-01T00:00:00Z', 'Rate not yet confirmed — set before the first partner payout.', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "TaxWithholdingRate" WHERE "appliesTo" = 'PARTNER');
