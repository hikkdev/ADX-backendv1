-- The General tab of the pricing model, and two things the rule builder draws.

ALTER TYPE "PriceRuleAdjustment" ADD VALUE 'OVERRIDE';

ALTER TABLE "PriceRule" ADD COLUMN "matchAny" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PriceModelSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "roundingRupees" INTEGER NOT NULL DEFAULT 100,
    "minimumRatePerDay" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "minimumBookingDays" INTEGER NOT NULL DEFAULT 7,
    "floorProtection" BOOLEAN NOT NULL DEFAULT true,
    "durationDiscounts" JSONB NOT NULL DEFAULT '[]',
    "approvalThresholdPct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "discountCeilingPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "maxStackedUplift" DECIMAL(6,4) NOT NULL DEFAULT 2.2,
    "blockBelowFloor" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PriceModelSettings_pkey" PRIMARY KEY ("id")
);
