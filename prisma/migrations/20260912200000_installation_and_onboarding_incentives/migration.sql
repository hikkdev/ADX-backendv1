-- Lot B (Q1/Q2/Q3/Q15): an installation pays a per-order commission at the
-- figure the offer showed; an attributed advertiser's activation pays the
-- agent like a publisher's onboarding does; a sale or a launch made on a field
-- visit is recorded as that visit's outcome.
ALTER TYPE "IncentiveEvent" ADD VALUE 'INSTALLATION';
ALTER TYPE "IncentiveEvent" ADD VALUE 'ADVERTISER_ONBOARDED';

ALTER TABLE "Order" ADD COLUMN "agentFeeAmount" DECIMAL(14,2);
ALTER TABLE "OrderAgentAssignment" ADD COLUMN "quotedFee" DECIMAL(14,2);
ALTER TABLE "PackageSale" ADD COLUMN "visitId" TEXT;
ALTER TABLE "Campaign"
  ADD COLUMN "visitId" TEXT,
  ADD COLUMN "assistIncentiveId" TEXT;
CREATE UNIQUE INDEX "Campaign_assistIncentiveId_key" ON "Campaign"("assistIncentiveId");
