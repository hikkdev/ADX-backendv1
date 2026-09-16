-- CreateEnum
CREATE TYPE "InstallBy" AS ENUM ('PUBLISHER', 'ADX');

-- CreateEnum
CREATE TYPE "OrderPhotoKind" AS ENUM ('PICKUP', 'CONDITION', 'INSTALLATION', 'REJECTION');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "displayId" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "agentTimerExpiry" TIMESTAMP(3),
ADD COLUMN     "installBy" "InstallBy";

-- CreateTable
CREATE TABLE "OrderPhoto" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "OrderPhotoKind" NOT NULL,
    "label" TEXT,
    "url" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByUserId" TEXT,

    CONSTRAINT "OrderPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderPhoto_orderId_kind_idx" ON "OrderPhoto"("orderId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_displayId_key" ON "Listing"("displayId");

-- AddForeignKey
ALTER TABLE "OrderPhoto" ADD CONSTRAINT "OrderPhoto_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- Invariants
-- ────────────────────────────────────────────────────────────────────

-- A photo is a photo.
ALTER TABLE "OrderPhoto"
  ADD CONSTRAINT "OrderPhoto_url_not_blank" CHECK (length(btrim("url")) > 0);

-- A coordinate is either whole or absent — half a fix is worse than none,
-- because it looks like evidence of place and is not.
ALTER TABLE "OrderPhoto"
  ADD CONSTRAINT "OrderPhoto_coordinates_are_whole"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

-- A listing that has been sent for review says when.
ALTER TABLE "Listing"
  ADD CONSTRAINT "Listing_submitted_is_dated"
  CHECK ("status" NOT IN ('PENDING_REVIEW','AWAITING_SITE_VERIFICATION','ACTIVE')
         OR "submittedAt" IS NOT NULL OR "publishedAt" IS NOT NULL);
