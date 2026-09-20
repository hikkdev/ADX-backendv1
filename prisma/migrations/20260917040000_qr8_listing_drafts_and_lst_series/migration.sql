-- QR-8 (17 Sep 2026): listing drafts, and the LISTING identifier series.
ALTER TYPE "PartyType" ADD VALUE IF NOT EXISTS 'LISTING';

CREATE TABLE "ListingDraft" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "category" TEXT,
    "title" TEXT,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "stepKey" TEXT,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ListingDraft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ListingDraft_displayId_key" ON "ListingDraft"("displayId");
CREATE INDEX "ListingDraft_publisherId_updatedAt_idx" ON "ListingDraft"("publisherId", "updatedAt");
CREATE INDEX "ListingDraft_updatedAt_idx" ON "ListingDraft"("updatedAt");
ALTER TABLE "ListingDraft" ADD CONSTRAINT "ListingDraft_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
