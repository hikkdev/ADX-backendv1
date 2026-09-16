-- Lot A (Q40/Q48/Q52/Q54): suspension is modular. Each party carries the
-- sections currently suspended; every step and every reversal is one event
-- row; a frozen wallet stops money leaving and nothing else.

CREATE TYPE "SuspensionScope" AS ENUM ('BLOCK_NEW', 'STOP_ORDERS', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN', 'OFFERS', 'OPEN_WORK');
CREATE TYPE "SuspendedPartyType" AS ENUM ('LISTING', 'PUBLISHER', 'ADVERTISER', 'AGENT');
CREATE TYPE "SuspensionAction" AS ENUM ('SUSPEND', 'REINSTATE');

-- Listing already carries "suspendedAt" from the supply enforcement sweep.
ALTER TABLE "Listing"
  ADD COLUMN "suspensionScopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[],
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "suspendedById" TEXT;

ALTER TABLE "Publisher"
  ADD COLUMN "suspensionScopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[],
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "suspendedById" TEXT;

ALTER TABLE "Advertiser"
  ADD COLUMN "suspensionScopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[],
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "suspendedById" TEXT;

ALTER TABLE "AgentProfile"
  ADD COLUMN "suspensionScopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[],
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "suspendedById" TEXT;

ALTER TABLE "Wallet"
  ADD COLUMN "frozenAt" TIMESTAMP(3),
  ADD COLUMN "frozenReason" TEXT,
  ADD COLUMN "frozenById" TEXT;

CREATE TABLE "PartySuspensionEvent" (
  "id" TEXT NOT NULL,
  "partyType" "SuspendedPartyType" NOT NULL,
  "partyId" TEXT NOT NULL,
  "action" "SuspensionAction" NOT NULL,
  "scopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[],
  "reason" TEXT NOT NULL,
  "byUserId" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartySuspensionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartySuspensionEvent_partyType_partyId_at_idx" ON "PartySuspensionEvent"("partyType", "partyId", "at");

-- A suspension always says why, and a frozen wallet always says why.
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_suspension_has_reason"
  CHECK (cardinality("suspensionScopes") = 0 OR ("suspensionReason" IS NOT NULL AND "suspendedAt" IS NOT NULL));
ALTER TABLE "Publisher" ADD CONSTRAINT "Publisher_suspension_has_reason"
  CHECK (cardinality("suspensionScopes") = 0 OR ("suspensionReason" IS NOT NULL AND "suspendedAt" IS NOT NULL));
ALTER TABLE "Advertiser" ADD CONSTRAINT "Advertiser_suspension_has_reason"
  CHECK (cardinality("suspensionScopes") = 0 OR ("suspensionReason" IS NOT NULL AND "suspendedAt" IS NOT NULL));
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_suspension_has_reason"
  CHECK (cardinality("suspensionScopes") = 0 OR ("suspensionReason" IS NOT NULL AND "suspendedAt" IS NOT NULL));
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_freeze_has_reason"
  CHECK ("frozenAt" IS NULL OR "frozenReason" IS NOT NULL);
