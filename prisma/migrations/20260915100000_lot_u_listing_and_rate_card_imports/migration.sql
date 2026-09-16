-- Lot U: bulk listing import and rate-card import for a publisher, on the party-import tables.
ALTER TYPE "ImportParty" ADD VALUE 'LISTING';
ALTER TYPE "ImportParty" ADD VALUE 'RATE_CARD';
ALTER TABLE "PartyImport" ADD COLUMN "publisherId" TEXT;
ALTER TABLE "PartyImport" ADD COLUMN "attemptId" TEXT;
CREATE INDEX "PartyImport_publisherId_party_idx" ON "PartyImport"("publisherId", "party");
