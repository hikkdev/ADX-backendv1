-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('PLATFORM', 'INSTALLATION', 'PRINTING', 'DESIGN');

-- CreateEnum
CREATE TYPE "SubscriptionTierName" AS ENUM ('STANDARD', 'PLUS', 'PRO');

-- CreateTable
CREATE TABLE "CommissionRate" (
    "id" TEXT NOT NULL,
    "category" "ListingCategory",
    "ratePct" DECIMAL(5,4) NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "CommissionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublisherSubscription" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "tier" "SubscriptionTierName" NOT NULL,
    "ratePct" DECIMAL(5,4) NOT NULL,
    "pricePerMonth" DECIMAL(14,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublisherSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublisherCommissionOverride" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "ratePct" DECIMAL(5,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublisherCommissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeSchedule" (
    "id" TEXT NOT NULL,
    "kind" "FeeKind" NOT NULL,
    "name" TEXT NOT NULL,
    "percentPct" DECIMAL(5,4),
    "flatAmount" DECIMAL(14,2),
    "gstPct" DECIMAL(5,4) NOT NULL DEFAULT 0.18,
    "amountShownInCart" BOOLEAN NOT NULL DEFAULT false,
    "perSpot" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "mediaGstPct" DECIMAL(5,4) NOT NULL DEFAULT 0.18,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "TaxSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceLock" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionRate_isActive_category_idx" ON "CommissionRate"("isActive", "category");

-- CreateIndex
CREATE INDEX "PublisherSubscription_publisherId_startsAt_idx" ON "PublisherSubscription"("publisherId", "startsAt");

-- CreateIndex
CREATE INDEX "PublisherSubscription_endsAt_idx" ON "PublisherSubscription"("endsAt");

-- CreateIndex
CREATE INDEX "PublisherCommissionOverride_publisherId_startsAt_idx" ON "PublisherCommissionOverride"("publisherId", "startsAt");

-- CreateIndex
CREATE INDEX "FeeSchedule_isActive_kind_idx" ON "FeeSchedule"("isActive", "kind");

-- CreateIndex
CREATE INDEX "PriceLock_expiresAt_idx" ON "PriceLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceLock_advertiserId_listingId_key" ON "PriceLock"("advertiserId", "listingId");

-- AddForeignKey
ALTER TABLE "PublisherSubscription" ADD CONSTRAINT "PublisherSubscription_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublisherCommissionOverride" ADD CONSTRAINT "PublisherCommissionOverride_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceLock" ADD CONSTRAINT "PriceLock_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceLock" ADD CONSTRAINT "PriceLock_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Invariants Prisma cannot express ────────────────────────────────────────

-- Exactly one active platform default. A default that is ambiguous is worse
-- than one that is wrong: whichever row the query happened to return would
-- decide ADX's take rate, and it could differ between two identical requests.
CREATE UNIQUE INDEX "CommissionRate_one_active_default"
  ON "CommissionRate" (("category" IS NULL))
  WHERE "category" IS NULL AND "isActive" = true;

-- One active rate per category, for the same reason.
CREATE UNIQUE INDEX "CommissionRate_one_active_per_category"
  ON "CommissionRate" ("category")
  WHERE "category" IS NOT NULL AND "isActive" = true;

-- A rate is a fraction, never a percentage typed as a whole number. 15 instead
-- of 0.15 would hand a publisher fifteen times their earnings.
ALTER TABLE "CommissionRate"
  ADD CONSTRAINT "CommissionRate_is_a_fraction" CHECK ("ratePct" >= 0 AND "ratePct" <= 1);
ALTER TABLE "PublisherSubscription"
  ADD CONSTRAINT "PublisherSubscription_is_a_fraction" CHECK ("ratePct" >= 0 AND "ratePct" <= 1);
ALTER TABLE "PublisherCommissionOverride"
  ADD CONSTRAINT "PublisherCommissionOverride_is_a_fraction" CHECK ("ratePct" >= 0 AND "ratePct" <= 1);

-- A fee is a percentage or a flat amount, never both and never neither.
ALTER TABLE "FeeSchedule"
  ADD CONSTRAINT "FeeSchedule_one_shape" CHECK (
    ("percentPct" IS NOT NULL AND "flatAmount" IS NULL)
    OR ("flatAmount" IS NOT NULL AND "percentPct" IS NULL)
  );

ALTER TABLE "FeeSchedule"
  ADD CONSTRAINT "FeeSchedule_amounts_non_negative" CHECK (
    ("percentPct" IS NULL OR ("percentPct" >= 0 AND "percentPct" <= 1))
    AND ("flatAmount" IS NULL OR "flatAmount" >= 0)
    AND "gstPct" >= 0 AND "gstPct" <= 1
  );

-- A window that ends before it starts pays nobody correctly.
ALTER TABLE "PublisherSubscription"
  ADD CONSTRAINT "PublisherSubscription_ends_after_start"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "PublisherCommissionOverride"
  ADD CONSTRAINT "PublisherCommissionOverride_ends_after_start"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "PriceLock"
  ADD CONSTRAINT "PriceLock_rate_positive" CHECK ("ratePerDay" > 0);

ALTER TABLE "TaxSettings"
  ADD CONSTRAINT "TaxSettings_singleton" CHECK ("id" = 'default');

INSERT INTO "TaxSettings" ("id", "updatedAt") VALUES ('default', NOW())
  ON CONFLICT ("id") DO NOTHING;
