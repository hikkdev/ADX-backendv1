-- Lot A (Q21/Q60): an account closes; a person's data is erased later, by a
-- DPO-signed request, while every financial row stays for the retention period.
-- Deleting a user with history is refused from here on (service rule).

ALTER TABLE "User"
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" TEXT,
  ADD COLUMN "closedById" TEXT;

CREATE TYPE "ClosureDecision" AS ENUM ('PENDING', 'CLOSED', 'REFUSED');

CREATE TABLE "AccountClosureCase" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ticketId" TEXT,
  "reason" TEXT NOT NULL,
  "requestedById" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "walletBalance" DECIMAL(14,2),
  "withdrawalsInFlight" INTEGER NOT NULL DEFAULT 0,
  "openOrders" INTEGER NOT NULL DEFAULT 0,
  "openWork" INTEGER NOT NULL DEFAULT 0,
  "lossNote" TEXT,
  "decision" "ClosureDecision" NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "AccountClosureCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountClosureCase_userId_requestedAt_idx" ON "AccountClosureCase"("userId", "requestedAt");
CREATE INDEX "AccountClosureCase_decision_requestedAt_idx" ON "AccountClosureCase"("decision", "requestedAt");

CREATE TYPE "ErasureStatus" AS ENUM ('PENDING', 'APPROVED', 'DONE', 'REFUSED');
CREATE TYPE "ErasureVia" AS ENUM ('APP', 'EMAIL', 'OPS');

CREATE TABLE "ErasureRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestedVia" "ErasureVia" NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "status" "ErasureStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "dpoName" TEXT,
  "completedAt" TIMESTAMP(3),
  "retainUntil" TIMESTAMP(3),
  "refusedReason" TEXT,
  CONSTRAINT "ErasureRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ErasureRequest_userId_idx" ON "ErasureRequest"("userId");
CREATE INDEX "ErasureRequest_status_dueAt_idx" ON "ErasureRequest"("status", "dueAt");
ALTER TABLE "ErasureRequest"
  ADD CONSTRAINT "ErasureRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MobileTombstone" (
  "mobileHash" TEXT NOT NULL,
  "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MobileTombstone_pkey" PRIMARY KEY ("mobileHash")
);

-- A closed account says why and who; an approved erasure says who signed.
ALTER TABLE "User" ADD CONSTRAINT "User_closure_has_reason"
  CHECK ("closedAt" IS NULL OR ("closeReason" IS NOT NULL AND "closedById" IS NOT NULL));
ALTER TABLE "ErasureRequest" ADD CONSTRAINT "ErasureRequest_approval_is_signed"
  CHECK ("status" NOT IN ('APPROVED', 'DONE') OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));
