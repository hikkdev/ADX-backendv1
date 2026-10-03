-- BD-1 (25 Sep 2026): dates a publisher takes a spot off the market — a block holds every slot over its range.
-- CreateTable
CREATE TABLE "ListingBlockedDate" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "from" DATE NOT NULL,
    "to" DATE NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingBlockedDate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingBlockedDate_listingId_from_to_idx" ON "ListingBlockedDate"("listingId", "from", "to");

-- AddForeignKey
ALTER TABLE "ListingBlockedDate" ADD CONSTRAINT "ListingBlockedDate_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
