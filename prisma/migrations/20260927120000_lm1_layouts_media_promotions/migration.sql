-- LM-1 (27 Sep 2026): layouts, the media library, ad slots, display-ad bookings, sponsored listings.
ALTER TYPE "PartyType" ADD VALUE 'AD_BOOKING';
ALTER TYPE "PartyType" ADD VALUE 'LISTING_BOOST';
ALTER TYPE "WalletEntryType" ADD VALUE 'PROMOTION_DEBIT';
ALTER TYPE "LedgerTransactionKind" ADD VALUE 'PROMOTION_SPEND';

CREATE TYPE "LayoutSurface" AS ENUM ('WEB_HOME', 'WEB_EXPLORE', 'WEB_FORMATS', 'WEB_LISTING', 'APP_ADVERTISER_HOME', 'APP_PUBLISHER_HOME', 'APP_PARTNER_HOME', 'AGENT_HOME');
CREATE TYPE "LayoutVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'ENDED', 'REJECTED', 'CANCELLED');
CREATE TYPE "BoostPlacement" AS ENUM ('SEARCH_TOP', 'SIMILAR_TOP');
CREATE TYPE "PromotionEventKind" AS ENUM ('IMPRESSION', 'CLICK');

CREATE TABLE "LayoutVersion" (
    "id" TEXT NOT NULL,
    "surface" "LayoutSurface" NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "LayoutVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "blocks" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdByUserId" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LayoutVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LayoutVersion_surface_number_key" ON "LayoutVersion"("surface", "number");
CREATE INDEX "LayoutVersion_surface_status_idx" ON "LayoutVersion"("surface", "status");

CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "fileId" TEXT,
    "url" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "altText" TEXT,
    "title" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spec" TEXT,
    "ownerAdvertiserId" TEXT,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MediaAsset_archivedAt_createdAt_idx" ON "MediaAsset"("archivedAt", "createdAt");
CREATE INDEX "MediaAsset_ownerAdvertiserId_idx" ON "MediaAsset"("ownerAdvertiserId");

CREATE TABLE "AdSlot" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "surfaces" "LayoutSurface"[],
    "spec" TEXT NOT NULL,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "minDays" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdSlot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdSlot_key_key" ON "AdSlot"("key");

CREATE TABLE "AdBooking" (
    "id" TEXT NOT NULL,
    "displayId" TEXT,
    "slotId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mediaId" TEXT,
    "headline" TEXT,
    "ctaLabel" TEXT,
    "targetUrl" TEXT,
    "cityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "walletEntryId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdBooking_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdBooking_displayId_key" ON "AdBooking"("displayId");
CREATE INDEX "AdBooking_slotId_status_startDate_endDate_idx" ON "AdBooking"("slotId", "status", "startDate", "endDate");
CREATE INDEX "AdBooking_advertiserId_createdAt_idx" ON "AdBooking"("advertiserId", "createdAt");
CREATE INDEX "AdBooking_status_startDate_idx" ON "AdBooking"("status", "startDate");
ALTER TABLE "AdBooking" ADD CONSTRAINT "AdBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "AdSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BoostPlacementConfig" (
    "placement" "BoostPlacement" NOT NULL,
    "label" TEXT NOT NULL,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 2,
    "minDays" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BoostPlacementConfig_pkey" PRIMARY KEY ("placement")
);

CREATE TABLE "ListingBoost" (
    "id" TEXT NOT NULL,
    "displayId" TEXT,
    "listingId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "placements" "BoostPlacement"[],
    "cityId" TEXT,
    "city" TEXT,
    "category" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewNote" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentId" TEXT,
    "walletEntryId" TEXT,
    "refundedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ListingBoost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ListingBoost_displayId_key" ON "ListingBoost"("displayId");
CREATE INDEX "ListingBoost_listingId_status_idx" ON "ListingBoost"("listingId", "status");
CREATE INDEX "ListingBoost_status_startDate_endDate_idx" ON "ListingBoost"("status", "startDate", "endDate");
CREATE INDEX "ListingBoost_publisherId_createdAt_idx" ON "ListingBoost"("publisherId", "createdAt");

CREATE TABLE "PromotionStat" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "adBookingId" TEXT,
    "boostId" TEXT,
    "surface" TEXT NOT NULL,
    "kind" "PromotionEventKind" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PromotionStat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PromotionStat_date_adBookingId_boostId_surface_kind_key" ON "PromotionStat"("date", "adBookingId", "boostId", "surface", "kind");
CREATE INDEX "PromotionStat_adBookingId_date_idx" ON "PromotionStat"("adBookingId", "date");
CREATE INDEX "PromotionStat_boostId_date_idx" ON "PromotionStat"("boostId", "date");

ALTER TABLE "Payment" ADD COLUMN "adBookingId" TEXT, ADD COLUMN "listingBoostId" TEXT;
CREATE INDEX "Payment_adBookingId_idx" ON "Payment"("adBookingId");
CREATE INDEX "Payment_listingBoostId_idx" ON "Payment"("listingBoostId");
