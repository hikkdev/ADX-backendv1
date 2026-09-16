-- DropIndex
DROP INDEX "MarketDataPoint_mediaTypeId_sizeClassId_isActive_idx";

-- AlterTable
ALTER TABLE "MarketDataPoint" ADD COLUMN     "venueTypeId" TEXT;

-- CreateIndex
CREATE INDEX "MarketDataPoint_venueTypeId_mediaTypeId_sizeClassId_isActiv_idx" ON "MarketDataPoint"("venueTypeId", "mediaTypeId", "sizeClassId", "isActive");
