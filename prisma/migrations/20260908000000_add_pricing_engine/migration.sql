-- CreateEnum
CREATE TYPE "MediaTypeStatus" AS ENUM ('ACTIVE', 'MERGED');

-- CreateEnum
CREATE TYPE "MediaTypeOrigin" AS ENUM ('SEEDED', 'OPS', 'AUTO_MATCHED');

-- CreateEnum
CREATE TYPE "MediaTypeMatchOutcome" AS ENUM ('MATCHED', 'CREATED');

-- CreateEnum
CREATE TYPE "MarketDataSource" AS ENUM ('RESEARCH', 'RATE_CARD');

-- CreateEnum
CREATE TYPE "PricingFactorKind" AS ENUM ('BASE_ADJUST', 'MULTIPLIER');

-- CreateEnum
CREATE TYPE "SurgeEventScope" AS ENUM ('CITY', 'NATIONAL', 'INTERNATIONAL');

-- CreateEnum
CREATE TYPE "SurgeEventSource" AS ENUM ('SCRAPER', 'OPS', 'AI_AGENT');

-- CreateEnum
CREATE TYPE "VocabularyKind" AS ENUM ('MEDIA_TYPE', 'SIZE_CLASS', 'MATERIAL');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "materialId" TEXT,
ADD COLUMN     "mediaTypeId" TEXT,
ADD COLUMN     "ratePerDay" DECIMAL(14,2),
ADD COLUMN     "sizeClassId" TEXT;

-- CreateTable
CREATE TABLE "MediaType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "ListingCategory" NOT NULL,
    "description" TEXT,
    "status" "MediaTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "origin" "MediaTypeOrigin" NOT NULL DEFAULT 'OPS',
    "mergedIntoId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeClass" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "widthFt" DECIMAL(8,2),
    "heightFt" DECIMAL(8,2),
    "areaSqFt" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SizeClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VocabularyProposal" (
    "id" TEXT NOT NULL,
    "kind" "VocabularyKind" NOT NULL,
    "rawValue" TEXT NOT NULL,
    "listingId" TEXT,
    "importId" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VocabularyProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaTypeMatchLog" (
    "id" TEXT NOT NULL,
    "proposedName" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "mediaTypeId" TEXT,
    "similarity" DECIMAL(5,4),
    "outcome" "MediaTypeMatchOutcome" NOT NULL,
    "listingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaTypeMatchLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDataImport" (
    "id" TEXT NOT NULL,
    "source" "MarketDataSource" NOT NULL,
    "filename" TEXT,
    "note" TEXT,
    "uploadedById" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "rejections" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketDataImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDataPoint" (
    "id" TEXT NOT NULL,
    "source" "MarketDataSource" NOT NULL,
    "importId" TEXT,
    "contributorKey" TEXT NOT NULL,
    "contributorName" TEXT,
    "publisherId" TEXT,
    "mediaTypeId" TEXT NOT NULL,
    "sizeClassId" TEXT NOT NULL,
    "materialId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "city" TEXT,
    "locality" TEXT,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketDataPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingFactor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PricingFactorKind" NOT NULL,
    "mediaTypeId" TEXT NOT NULL,
    "multiplier" DECIMAL(6,4),
    "baseAdjust" DECIMAL(14,2),
    "suggestWhen" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingPricingFactor" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "factorId" TEXT NOT NULL,
    "suggested" BOOLEAN NOT NULL DEFAULT false,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingPricingFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurgeEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "SurgeEventScope" NOT NULL,
    "source" "SurgeEventSource" NOT NULL DEFAULT 'SCRAPER',
    "externalRef" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusMeters" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "upliftPct" DECIMAL(5,4) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledById" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledNote" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurgeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "radiusMeters" INTEGER NOT NULL DEFAULT 200,
    "highEdgePct" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "lowEdgePct" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "thinEvidenceCount" INTEGER NOT NULL DEFAULT 3,
    "minContributors" INTEGER NOT NULL DEFAULT 1,
    "stalenessMonths" INTEGER NOT NULL DEFAULT 6,
    "mediaTypeMatchThreshold" DECIMAL(5,4) NOT NULL DEFAULT 0.75,
    "maxCompoundMultiplier" DECIMAL(6,4) NOT NULL DEFAULT 3.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PricingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaType_slug_key" ON "MediaType"("slug");

-- CreateIndex
CREATE INDEX "MediaType_category_status_idx" ON "MediaType"("category", "status");

-- CreateIndex
CREATE INDEX "MediaType_mergedIntoId_idx" ON "MediaType"("mergedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "SizeClass_slug_key" ON "SizeClass"("slug");

-- CreateIndex
CREATE INDEX "SizeClass_isActive_idx" ON "SizeClass"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Material_slug_key" ON "Material"("slug");

-- CreateIndex
CREATE INDEX "VocabularyProposal_resolvedAt_idx" ON "VocabularyProposal"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VocabularyProposal_kind_rawValue_key" ON "VocabularyProposal"("kind", "rawValue");

-- CreateIndex
CREATE INDEX "MediaTypeMatchLog_outcome_createdAt_idx" ON "MediaTypeMatchLog"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "MediaTypeMatchLog_mediaTypeId_idx" ON "MediaTypeMatchLog"("mediaTypeId");

-- CreateIndex
CREATE INDEX "MarketDataImport_source_createdAt_idx" ON "MarketDataImport"("source", "createdAt");

-- CreateIndex
CREATE INDEX "MarketDataPoint_mediaTypeId_sizeClassId_isActive_idx" ON "MarketDataPoint"("mediaTypeId", "sizeClassId", "isActive");

-- CreateIndex
CREATE INDEX "MarketDataPoint_latitude_longitude_idx" ON "MarketDataPoint"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "MarketDataPoint_importId_idx" ON "MarketDataPoint"("importId");

-- CreateIndex
CREATE INDEX "MarketDataPoint_publisherId_idx" ON "MarketDataPoint"("publisherId");

-- CreateIndex
CREATE INDEX "PricingFactor_mediaTypeId_isActive_idx" ON "PricingFactor"("mediaTypeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PricingFactor_mediaTypeId_slug_key" ON "PricingFactor"("mediaTypeId", "slug");

-- CreateIndex
CREATE INDEX "ListingPricingFactor_listingId_applied_idx" ON "ListingPricingFactor"("listingId", "applied");

-- CreateIndex
CREATE UNIQUE INDEX "ListingPricingFactor_listingId_factorId_key" ON "ListingPricingFactor"("listingId", "factorId");

-- CreateIndex
CREATE INDEX "SurgeEvent_isEnabled_startsAt_endsAt_idx" ON "SurgeEvent"("isEnabled", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "SurgeEvent_city_startsAt_idx" ON "SurgeEvent"("city", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeEvent_source_externalRef_key" ON "SurgeEvent"("source", "externalRef");

-- CreateIndex
CREATE INDEX "Listing_mediaTypeId_sizeClassId_status_idx" ON "Listing"("mediaTypeId", "sizeClassId", "status");

-- CreateIndex
CREATE INDEX "Listing_latitude_longitude_idx" ON "Listing"("latitude", "longitude");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sizeClassId_fkey" FOREIGN KEY ("sizeClassId") REFERENCES "SizeClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaType" ADD CONSTRAINT "MediaType_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "MediaType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTypeMatchLog" ADD CONSTRAINT "MediaTypeMatchLog_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataPoint" ADD CONSTRAINT "MarketDataPoint_importId_fkey" FOREIGN KEY ("importId") REFERENCES "MarketDataImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataPoint" ADD CONSTRAINT "MarketDataPoint_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataPoint" ADD CONSTRAINT "MarketDataPoint_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataPoint" ADD CONSTRAINT "MarketDataPoint_sizeClassId_fkey" FOREIGN KEY ("sizeClassId") REFERENCES "SizeClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketDataPoint" ADD CONSTRAINT "MarketDataPoint_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingFactor" ADD CONSTRAINT "PricingFactor_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingPricingFactor" ADD CONSTRAINT "ListingPricingFactor_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingPricingFactor" ADD CONSTRAINT "ListingPricingFactor_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "PricingFactor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Invariants Prisma cannot express ────────────────────────────────────────

-- A factor carries exactly the value its kind implies. Overloading one column
-- for both would let a MULTIPLIER of 250.00 through as if it were rupees.
ALTER TABLE "PricingFactor"
  ADD CONSTRAINT "PricingFactor_value_matches_kind" CHECK (
    ("kind" = 'MULTIPLIER'  AND "multiplier" IS NOT NULL AND "baseAdjust" IS NULL)
    OR
    ("kind" = 'BASE_ADJUST' AND "baseAdjust" IS NOT NULL AND "multiplier" IS NULL)
  );

-- A multiplier below 1 is a discount and legitimate; one at or below zero is a
-- data-entry accident that would zero or invert a price.
ALTER TABLE "PricingFactor"
  ADD CONSTRAINT "PricingFactor_multiplier_positive" CHECK (
    "multiplier" IS NULL OR "multiplier" > 0
  );

-- A window that ends before it starts is always a scrape gone wrong, and it
-- would otherwise sit in the calendar matching nothing and explaining nothing.
ALTER TABLE "SurgeEvent"
  ADD CONSTRAINT "SurgeEvent_ends_after_start" CHECK ("endsAt" > "startsAt");

-- Uplift lifts the ceiling; it never lowers it. A negative value here would
-- quietly flag every honest price in the window as too high.
ALTER TABLE "SurgeEvent"
  ADD CONSTRAINT "SurgeEvent_uplift_non_negative" CHECK ("upliftPct" >= 0);

-- A city-scoped window needs somewhere to apply. National and international
-- ones apply everywhere by definition.
ALTER TABLE "SurgeEvent"
  ADD CONSTRAINT "SurgeEvent_city_scope_has_place" CHECK (
    "scope" <> 'CITY' OR "city" IS NOT NULL OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL)
  );

-- Market data is only ever a positive rate per day. Zero would drag a range to
-- the floor and flag every real price nearby as too high.
ALTER TABLE "MarketDataPoint"
  ADD CONSTRAINT "MarketDataPoint_rate_positive" CHECK ("ratePerDay" > 0);

-- The settings row is a singleton. Without this, a second row makes "the
-- radius" a question with two answers.
ALTER TABLE "PricingSettings"
  ADD CONSTRAINT "PricingSettings_singleton" CHECK ("id" = 'default');

-- Seed it, so the engine has something to read on first boot.
INSERT INTO "PricingSettings" ("id", "updatedAt") VALUES ('default', NOW())
  ON CONFLICT ("id") DO NOTHING;
