-- LD-1 (3 Oct 2026): listing data gaps — store what the forms ask, count spot-page views.
-- Additive only: new nullable columns, two new tables, one index.

-- The answers the forms collected and threw away.
ALTER TABLE "Listing" ADD COLUMN     "coverage" TEXT,
ADD COLUMN     "documentWaivers" JSONB,
ADD COLUMN     "extraAnswers" JSONB,
ADD COLUMN     "locationAccuracyM" DOUBLE PRECISION,
ADD COLUMN     "operatingHoursFrom" TEXT,
ADD COLUMN     "operatingHoursTo" TEXT,
ADD COLUMN     "ownershipDeclaredAt" TIMESTAMP(3),
ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

-- A photograph's upload-register row and its capture time.
ALTER TABLE "ListingPhoto" ADD COLUMN     "takenAt" TIMESTAMP(3),
ADD COLUMN     "uploadedFileId" TEXT;

-- Spot-page views, per listing per Indian day.
CREATE TABLE "ListingView" (
    "listingId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "uniqueVisitors" INTEGER NOT NULL DEFAULT 0,
    "webViews" INTEGER NOT NULL DEFAULT 0,
    "appViews" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingView_pkey" PRIMARY KEY ("listingId","day")
);

-- Today's de-duplication keys (keyed hashes, never an address or an id).
CREATE TABLE "ListingViewVisitor" (
    "listingId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "lastViewAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingViewVisitor_pkey" PRIMARY KEY ("listingId","day","visitorHash")
);

CREATE INDEX "ListingView_day_idx" ON "ListingView"("day");

-- The console matched photographs to the upload register by URL with no index.
CREATE INDEX "UploadedFile_url_idx" ON "UploadedFile"("url");

ALTER TABLE "ListingView" ADD CONSTRAINT "ListingView_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ListingViewVisitor" ADD CONSTRAINT "ListingViewVisitor_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
