-- A12: a dispatched visit is an offer with a window, an answer, and a scheduled slot.
ALTER TABLE "OrderMilestone"
  ADD COLUMN "offeredAt" TIMESTAMP(3),
  ADD COLUMN "offerExpiresAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "scheduledStart" TIMESTAMP(3),
  ADD COLUMN "scheduledEnd" TIMESTAMP(3);

-- Everything dispatched before offers existed was the holder's own work: accepted.
UPDATE "OrderMilestone" SET "acceptedAt" = "updatedAt"
  WHERE "status" IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED') AND "assignedAgentId" IS NOT NULL;

CREATE INDEX "OrderMilestone_status_offerExpiresAt_idx" ON "OrderMilestone"("status", "offerExpiresAt");
