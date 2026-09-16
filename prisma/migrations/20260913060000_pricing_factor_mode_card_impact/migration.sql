-- Lot E (Q59/Q67/Q97/Q125): advisory by default, binding per factor within a
-- cap; a revised card raises a price case per listing it puts under the floor.
CREATE TYPE "PricingFactorMode" AS ENUM ('ADVISORY', 'BINDING');
CREATE TYPE "PriceApprovalSource" AS ENUM ('PUBLISH_REQUEST', 'CARD_REVISION');

ALTER TABLE "PricingFactor"
  ADD COLUMN "mode" "PricingFactorMode" NOT NULL DEFAULT 'ADVISORY',
  ADD COLUMN "bindingDuringSurgeOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ListingPricingFactor" ADD COLUMN "appliedRatePerDay" DECIMAL(14,2);
ALTER TABLE "PricingSettings" ADD COLUMN "maxBindingChangePct" DECIMAL(5,4) NOT NULL DEFAULT 0.25;
ALTER TABLE "RateCard" ADD COLUMN "graceDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "PriceApproval"
  ADD COLUMN "source" "PriceApprovalSource" NOT NULL DEFAULT 'PUBLISH_REQUEST',
  ADD COLUMN "graceUntil" TIMESTAMP(3);
