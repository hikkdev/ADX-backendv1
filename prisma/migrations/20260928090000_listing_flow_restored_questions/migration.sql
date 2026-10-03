-- LF-2 (28 Sep 2026): the website's listing questions, now the flow's on every surface.
ALTER TYPE "ListingDocumentKind" ADD VALUE IF NOT EXISTS 'AUDIENCE_RATING';
ALTER TYPE "ListingDocumentKind" ADD VALUE IF NOT EXISTS 'FOOTFALL_AUDIT';
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "cancellationPolicy" TEXT;
