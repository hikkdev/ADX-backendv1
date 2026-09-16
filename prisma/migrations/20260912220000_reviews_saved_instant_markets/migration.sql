-- Lot D (Q5/Q6/Q8/Q19): one review table for spots and agents, saved spaces,
-- instant booking, multi-market campaigns, audited cancellation, reassignment.
CREATE TYPE "ReviewSubjectType" AS ENUM ('LISTING', 'AGENT');
CREATE TYPE "ReviewAnchorKind" AS ENUM ('ORDER', 'CAMPAIGN_SPOT');
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

CREATE TABLE "Review" (
  "id" TEXT NOT NULL,
  "subjectType" "ReviewSubjectType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "authorPublisherId" TEXT,
  "authorAdvertiserId" TEXT,
  "anchorKind" "ReviewAnchorKind" NOT NULL,
  "anchorId" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "note" TEXT,
  "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
  "hiddenReason" TEXT,
  "hiddenById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Review_anchorKind_anchorId_subjectType_key" ON "Review"("anchorKind", "anchorId", "subjectType");
CREATE INDEX "Review_subjectType_subjectId_status_createdAt_idx" ON "Review"("subjectType", "subjectId", "status", "createdAt");
CREATE INDEX "Review_authorUserId_idx" ON "Review"("authorUserId");
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "Review" ADD CONSTRAINT "Review_hidden_has_reason" CHECK ("status" <> 'HIDDEN' OR "hiddenReason" IS NOT NULL);
-- A publisher rates an agent once, ever (question 19).
CREATE UNIQUE INDEX "Review_publisher_rates_agent_once" ON "Review"("authorPublisherId", "subjectId") WHERE "subjectType" = 'AGENT' AND "authorPublisherId" IS NOT NULL;

CREATE TABLE "SavedListing" (
  "id" TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedListing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedListing_advertiserId_listingId_key" ON "SavedListing"("advertiserId", "listingId");
CREATE INDEX "SavedListing_listingId_idx" ON "SavedListing"("listingId");

ALTER TABLE "Listing"
  ADD COLUMN "instantBooking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ratingAvg" DECIMAL(3,2),
  ADD COLUMN "reviewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentRating"
  ADD COLUMN "reviewAvg" DECIMAL(3,2),
  ADD COLUMN "reviewCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Order"
  ADD COLUMN "autoAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancellationReason" TEXT;
ALTER TYPE "AssignmentStatus" ADD VALUE 'REASSIGNED';

ALTER TABLE "Campaign"
  ADD COLUMN "targetMarkets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "contentCategoryId" TEXT;
UPDATE "Campaign" SET "targetMarkets" = ARRAY["targetMarket"] WHERE "targetMarket" IS NOT NULL;
