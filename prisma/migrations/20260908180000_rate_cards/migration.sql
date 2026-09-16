-- Rate cards: ADX's approved position on what a kind of spot is worth, and the
-- gate DR 10 puts in front of publishing.

CREATE TYPE "RateCardStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');
CREATE TYPE "RateGrade" AS ENUM ('PREMIUM', 'A', 'B', 'C');
CREATE TYPE "PriceApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Listing" ADD COLUMN "rateGrade" "RateGrade";

CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "RateCardStatus" NOT NULL DEFAULT 'DRAFT',
    "cityId" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "floorPct" DECIMAL(5,4) NOT NULL DEFAULT 0.82,
    "roundingRupees" INTEGER NOT NULL DEFAULT 100,
    "notes" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateCard_supersedesId_key" ON "RateCard"("supersedesId");
CREATE INDEX "RateCard_status_effectiveFrom_idx" ON "RateCard"("status", "effectiveFrom");
CREATE INDEX "RateCard_cityId_status_idx" ON "RateCard"("cityId", "status");

ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "RateCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RateCardEntry" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "mediaTypeId" TEXT NOT NULL,
    "grade" "RateGrade" NOT NULL,
    "ratePerDay" DECIMAL(14,2),

    CONSTRAINT "RateCardEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateCardEntry_rateCardId_mediaTypeId_grade_key"
    ON "RateCardEntry"("rateCardId", "mediaTypeId", "grade");
CREATE INDEX "RateCardEntry_mediaTypeId_idx" ON "RateCardEntry"("mediaTypeId");

ALTER TABLE "RateCardEntry" ADD CONSTRAINT "RateCardEntry_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RateCardEntry" ADD CONSTRAINT "RateCardEntry_mediaTypeId_fkey"
    FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PriceApproval" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "rateCardId" TEXT,
    "status" "PriceApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedRatePerDay" DECIMAL(14,2) NOT NULL,
    "cardRatePerDay" DECIMAL(14,2),
    "floorRatePerDay" DECIMAL(14,2),
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PriceApproval_status_createdAt_idx" ON "PriceApproval"("status", "createdAt");
CREATE INDEX "PriceApproval_listingId_idx" ON "PriceApproval"("listingId");

ALTER TABLE "PriceApproval" ADD CONSTRAINT "PriceApproval_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceApproval" ADD CONSTRAINT "PriceApproval_rateCardId_fkey"
    FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
