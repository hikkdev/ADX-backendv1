-- The named areas inside a venue. Offered as the "placement area" DR 02 asks
-- for in step 4, rather than collected as free text nobody can group later.
-- AlterTable
ALTER TABLE "VenueType" ADD COLUMN "subVenues" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Renamed, not dropped and re-added: the design calls this the peak period,
-- which is a claim about when the spot is worth most rather than a note about
-- when it is free at all. A drop would silently lose whatever is already there.
-- AlterTable
ALTER TABLE "Listing" RENAME COLUMN "availableDaysNote" TO "peakPeriodNote";

-- An unrecognised venue name has to reach the same ops queue an unrecognised
-- size class does, or the venue vocabulary is the one list with no way to grow.
-- AlterEnum
ALTER TYPE "VocabularyKind" ADD VALUE 'VENUE_TYPE';
