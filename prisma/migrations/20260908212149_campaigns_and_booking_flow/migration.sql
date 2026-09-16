-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignGoal" AS ENUM ('BRAND_AWARENESS', 'DIGITAL_LIFT', 'LOCAL_FOOTFALL');

-- CreateEnum
CREATE TYPE "BrandAwarenessLevel" AS ENUM ('BRAND_NEW', 'ALREADY_ESTABLISHED');

-- CreateEnum
CREATE TYPE "TargetingMethod" AS ENUM ('RADIUS', 'MARKET_OR_DMA', 'POI_VENUE');

-- CreateEnum
CREATE TYPE "CampaignStrategy" AS ENUM ('DEFENSIVE', 'GENERAL', 'ATTACK');

-- CreateEnum
CREATE TYPE "AudiencePersona" AS ENUM ('B2B_DECISION_MAKERS', 'STUDENTS_OR_GEN_Z', 'HIGH_INCOME_CONSUMERS', 'FAMILIES_OR_SUBURBAN');

-- CreateEnum
CREATE TYPE "CampaignTriggerType" AS ENUM ('NONE', 'WEATHER', 'TIME_OF_DAY', 'EVENT');

-- CreateEnum
CREATE TYPE "CreativePath" AS ENUM ('STATIC_IMAGES', 'VIDEO_OR_MOTION', 'DYNAMIC_HTML5', 'ADX_DESIGN_AGENCY');

-- CreateEnum
CREATE TYPE "TrackingMethod" AS ENUM ('QR_OR_DEEPLINK', 'VANITY_OR_PROMO', 'LOCATION_LIFT', 'NONE');

-- CreateEnum
CREATE TYPE "FulfilmentChoice" AS ENUM ('ADX_PRINTS', 'ADVERTISER_SHIPS');

-- CreateEnum
CREATE TYPE "CampaignSpotStatus" AS ENUM ('RESERVED', 'BOOKED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TrackingEventType" AS ENUM ('SCAN', 'CLICK', 'REDEMPTION');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "estimatedDailyFootfall" INTEGER;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "brandId" TEXT,
    "agentId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "step" INTEGER NOT NULL DEFAULT 1,
    "brandName" TEXT,
    "productName" TEXT,
    "industry" TEXT,
    "subCategory" TEXT,
    "goal" "CampaignGoal",
    "awareness" "BrandAwarenessLevel",
    "targetingMethod" "TargetingMethod",
    "targetLocation" TEXT,
    "targetLatitude" DOUBLE PRECISION,
    "targetLongitude" DOUBLE PRECISION,
    "targetRadiusKm" INTEGER,
    "targetMarket" TEXT,
    "strategy" "CampaignStrategy",
    "persona" "AudiencePersona",
    "triggerType" "CampaignTriggerType" NOT NULL DEFAULT 'NONE',
    "triggerConfig" JSONB,
    "budget" DECIMAL(14,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "creativePath" "CreativePath",
    "creativeConfig" JSONB,
    "trackingMethod" "TrackingMethod" NOT NULL DEFAULT 'NONE',
    "trackingConfig" JSONB,
    "fulfilment" "FulfilmentChoice",
    "spotsSubtotal" DECIMAL(14,2),
    "feesTotal" DECIMAL(14,2),
    "discount" DECIMAL(14,2),
    "gstAmount" DECIMAL(14,2),
    "total" DECIMAL(14,2),
    "walletHoldId" TEXT,
    "paidAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignPoi" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,

    CONSTRAINT "CampaignPoi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSpot" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "status" "CampaignSpotStatus" NOT NULL DEFAULT 'RESERVED',
    "matchScore" INTEGER,
    "ratePerDay" DECIMAL(14,2) NOT NULL,
    "days" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSpot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCreative" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "spotId" TEXT,
    "path" "CreativePath" NOT NULL,
    "status" "CreativeStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "fileUrl" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "durationMs" INTEGER,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCreative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTrackingCode" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "spotId" TEXT,
    "code" TEXT NOT NULL,
    "method" "TrackingMethod" NOT NULL,
    "destination" TEXT,
    "vanityPath" TEXT,
    "promoCode" TEXT,
    "scans" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTrackingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "type" "TrackingEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "city" TEXT,
    "device" TEXT,
    "referer" TEXT,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDailyMetric" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "spotsLive" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "scans" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "estimatedReach" INTEGER,
    "reachFromSpots" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_reference_key" ON "Campaign"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_walletHoldId_key" ON "Campaign"("walletHoldId");

-- CreateIndex
CREATE INDEX "Campaign_advertiserId_status_idx" ON "Campaign"("advertiserId", "status");

-- CreateIndex
CREATE INDEX "Campaign_agentId_idx" ON "Campaign"("agentId");

-- CreateIndex
CREATE INDEX "Campaign_status_startDate_idx" ON "Campaign"("status", "startDate");

-- CreateIndex
CREATE INDEX "CampaignPoi_campaignId_idx" ON "CampaignPoi"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSpot_orderId_key" ON "CampaignSpot"("orderId");

-- CreateIndex
CREATE INDEX "CampaignSpot_campaignId_status_idx" ON "CampaignSpot"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignSpot_listingId_idx" ON "CampaignSpot"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSpot_campaignId_listingId_key" ON "CampaignSpot"("campaignId", "listingId");

-- CreateIndex
CREATE INDEX "CampaignCreative_campaignId_status_idx" ON "CampaignCreative"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignCreative_spotId_idx" ON "CampaignCreative"("spotId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTrackingCode_code_key" ON "CampaignTrackingCode"("code");

-- CreateIndex
CREATE INDEX "CampaignTrackingCode_campaignId_idx" ON "CampaignTrackingCode"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignTrackingCode_spotId_idx" ON "CampaignTrackingCode"("spotId");

-- CreateIndex
CREATE INDEX "TrackingEvent_codeId_occurredAt_idx" ON "TrackingEvent"("codeId", "occurredAt");

-- CreateIndex
CREATE INDEX "TrackingEvent_type_occurredAt_idx" ON "TrackingEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "CampaignDailyMetric_day_idx" ON "CampaignDailyMetric"("day");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDailyMetric_campaignId_day_key" ON "CampaignDailyMetric"("campaignId", "day");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPoi" ADD CONSTRAINT "CampaignPoi_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSpot" ADD CONSTRAINT "CampaignSpot_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSpot" ADD CONSTRAINT "CampaignSpot_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSpot" ADD CONSTRAINT "CampaignSpot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreative" ADD CONSTRAINT "CampaignCreative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreative" ADD CONSTRAINT "CampaignCreative_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "CampaignSpot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTrackingCode" ADD CONSTRAINT "CampaignTrackingCode_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTrackingCode" ADD CONSTRAINT "CampaignTrackingCode_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "CampaignSpot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "CampaignTrackingCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDailyMetric" ADD CONSTRAINT "CampaignDailyMetric_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
