-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "ratePerDaySetAt" TIMESTAMP(3),
ADD COLUMN     "ratePerDaySetDuringSurge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PricingSettings" ADD COLUMN     "validatedTakeoverCount" INTEGER NOT NULL DEFAULT 3;

-- ─── Invariant missed on the first pass ──────────────────────────────────────

-- MarketDataPoint got this and Listing did not, though both feed the same pool.
-- A listing priced at zero drags the range to the floor and flags every honest
-- price nearby as too high -- the exact failure the other constraint prevents,
-- reachable through the other door.
ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_rate_per_day_positive" CHECK (
    "ratePerDay" IS NULL OR "ratePerDay" > 0
  );
