-- Lot S: one importer for advertisers, agents, print partners and employees.
CREATE TYPE "ImportParty" AS ENUM ('ADVERTISER', 'AGENT', 'PRINT_PARTNER', 'EMPLOYEE');
CREATE TABLE "PartyImport" (
  "id" TEXT NOT NULL,
  "party" "ImportParty" NOT NULL,
  "fileName" TEXT NOT NULL,
  "note" TEXT,
  "uploadedById" TEXT NOT NULL,
  "status" "PublisherImportStatus" NOT NULL DEFAULT 'VALIDATED',
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "createdCount" INTEGER NOT NULL DEFAULT 0,
  "mergedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "warningCount" INTEGER NOT NULL DEFAULT 0,
  "invalidCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  CONSTRAINT "PartyImport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartyImport_party_createdAt_idx" ON "PartyImport"("party", "createdAt");
CREATE TABLE "PartyImportRow" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  "outcome" "PublisherImportOutcome" NOT NULL,
  "targetId" TEXT,
  "message" TEXT,
  CONSTRAINT "PartyImportRow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PartyImportRow_importId_rowNumber_idx" ON "PartyImportRow"("importId", "rowNumber");
ALTER TABLE "PartyImportRow" ADD CONSTRAINT "PartyImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "PartyImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
