-- Order fraud screening (the owner, 2 Oct 2026): every order is scored, the
-- desk reviews what the score flags, and an order can be held — reversibly —
-- while it is looked at. Additive only: two new enums and nullable columns
-- (the cleared-keys list defaults to empty), so every existing order reads
-- as never scored, never flagged and not held.
CREATE TYPE "OrderRiskBand" AS ENUM ('LOW', 'REVIEW', 'HOLD');
CREATE TYPE "OrderRiskReview" AS ENUM ('FLAGGED', 'CLEARED', 'CONFIRMED_FRAUD');

ALTER TABLE "Order"
  ADD COLUMN "riskScore" DECIMAL(4,3),
  ADD COLUMN "riskSignals" JSONB,
  ADD COLUMN "riskBand" "OrderRiskBand",
  ADD COLUMN "riskScoredAt" TIMESTAMP(3),
  ADD COLUMN "riskReviewStatus" "OrderRiskReview",
  ADD COLUMN "riskReviewedById" TEXT,
  ADD COLUMN "riskReviewedAt" TIMESTAMP(3),
  ADD COLUMN "riskReviewNote" TEXT,
  ADD COLUMN "riskClearedSignalKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "heldAt" TIMESTAMP(3),
  ADD COLUMN "heldById" TEXT,
  ADD COLUMN "holdReason" TEXT,
  ADD COLUMN "fraudCaseId" TEXT;

-- The review queue: by status and score, and the held tab.
CREATE INDEX "Order_riskReviewStatus_riskScore_idx" ON "Order"("riskReviewStatus", "riskScore");
CREATE INDEX "Order_heldAt_idx" ON "Order"("heldAt");
