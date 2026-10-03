-- WG-1 (25 Sep 2026): what the DR 12 website boards draw that the backend had no column for.
-- AlterEnum
ALTER TYPE "ListingDocumentKind" ADD VALUE 'DRIVING_LICENCE';
ALTER TYPE "ListingDocumentKind" ADD VALUE 'VEHICLE_INSURANCE';
ALTER TYPE "ListingDocumentKind" ADD VALUE 'VEHICLE_FITNESS';
ALTER TYPE "ListingDocumentKind" ADD VALUE 'MEDIA_KIT';
ALTER TYPE "ListingDocumentKind" ADD VALUE 'RATE_CARD';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "installationByAdx" BOOLEAN,
ADD COLUMN "vehicleType" TEXT,
ADD COLUMN "vehicleModel" TEXT,
ADD COLUMN "broadcastLanguage" TEXT,
ADD COLUMN "contentFormat" TEXT,
ADD COLUMN "audienceDemographics" JSONB,
ADD COLUMN "maxBookingDays" INTEGER,
ADD COLUMN "advanceBookingDays" INTEGER,
ADD COLUMN "cancellationNoticeDays" INTEGER,
ADD COLUMN "rateCardValidFrom" DATE,
ADD COLUMN "rateCardValidTo" DATE,
ADD COLUMN "seasonalVariationNote" TEXT,
ADD COLUMN "widthPx" INTEGER,
ADD COLUMN "heightPx" INTEGER;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "placementPreferences" JSONB,
ADD COLUMN "brandApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "contactName" TEXT,
ADD COLUMN "contactEmail" TEXT,
ADD COLUMN "contactPhone" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "relatedCampaignId" TEXT;
