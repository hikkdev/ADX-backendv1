-- CreateEnum
CREATE TYPE "PricingUnit" AS ENUM ('PER_DAY', 'PER_WEEK', 'PER_MONTH', 'PER_SQFT_PER_DAY', 'PER_SQFT_PER_MONTH');

-- CreateEnum
CREATE TYPE "ContentStance" AS ENUM ('ALLOWED', 'REQUIRES_APPROVAL', 'NOT_ALLOWED', 'PROHIBITED');

-- DropIndex
DROP INDEX "Listing_mediaTypeId_sizeClassId_status_idx";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "areaSqFt" DECIMAL(10,2),
ADD COLUMN     "availableDaysNote" TEXT,
ADD COLUMN     "availableFrom" TIMESTAMP(3),
ADD COLUMN     "availableHoursFrom" TEXT,
ADD COLUMN     "availableHoursTo" TEXT,
ADD COLUMN     "basePrice" DECIMAL(14,2),
ADD COLUMN     "footfallNote" TEXT,
ADD COLUMN     "heightFt" DECIMAL(8,2),
ADD COLUMN     "minBookingDays" INTEGER,
ADD COLUMN     "placement" TEXT,
ADD COLUMN     "pricingUnit" "PricingUnit" NOT NULL DEFAULT 'PER_DAY',
ADD COLUMN     "rateCardUrl" TEXT,
ADD COLUMN     "targetAudience" TEXT,
ADD COLUMN     "venueTypeId" TEXT,
ADD COLUMN     "visibilityNote" TEXT,
ADD COLUMN     "widthFt" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "MediaType" ADD COLUMN     "venueTypeId" TEXT;

-- CreateTable
CREATE TABLE "VenueType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "ListingCategory" NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingContentRule" (
    "listingId" TEXT NOT NULL,
    "contentCategoryId" TEXT NOT NULL,
    "stance" "ContentStance" NOT NULL,

    CONSTRAINT "ListingContentRule_pkey" PRIMARY KEY ("listingId","contentCategoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueType_slug_key" ON "VenueType"("slug");

-- CreateIndex
CREATE INDEX "VenueType_category_isActive_idx" ON "VenueType"("category", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ContentCategory_slug_key" ON "ContentCategory"("slug");

-- CreateIndex
CREATE INDEX "ContentCategory_isActive_idx" ON "ContentCategory"("isActive");

-- CreateIndex
CREATE INDEX "ListingContentRule_contentCategoryId_idx" ON "ListingContentRule"("contentCategoryId");

-- CreateIndex
CREATE INDEX "Listing_venueTypeId_mediaTypeId_sizeClassId_status_idx" ON "Listing"("venueTypeId", "mediaTypeId", "sizeClassId", "status");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_venueTypeId_fkey" FOREIGN KEY ("venueTypeId") REFERENCES "VenueType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaType" ADD CONSTRAINT "MediaType_venueTypeId_fkey" FOREIGN KEY ("venueTypeId") REFERENCES "VenueType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingContentRule" ADD CONSTRAINT "ListingContentRule_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingContentRule" ADD CONSTRAINT "ListingContentRule_contentCategoryId_fkey" FOREIGN KEY ("contentCategoryId") REFERENCES "ContentCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dimensions are positive or absent, never zero. A zero-area spot would divide
-- by nothing when a per-square-foot rate is converted to a daily one.
ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_dimensions_positive" CHECK (
    ("widthFt"  IS NULL OR "widthFt"  > 0)
    AND ("heightFt" IS NULL OR "heightFt" > 0)
    AND ("areaSqFt" IS NULL OR "areaSqFt" > 0)
  );

-- A per-square-foot price is meaningless without an area to multiply it by, and
-- the conversion to a daily rate would silently produce zero.
ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_sqft_pricing_needs_area" CHECK (
    "pricingUnit" NOT IN ('PER_SQFT_PER_DAY', 'PER_SQFT_PER_MONTH')
    OR "areaSqFt" IS NOT NULL
  );

ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_base_price_positive" CHECK ("basePrice" IS NULL OR "basePrice" > 0);

ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_min_booking_positive" CHECK ("minBookingDays" IS NULL OR "minBookingDays" > 0);
