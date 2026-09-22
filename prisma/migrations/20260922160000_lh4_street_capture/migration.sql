-- LH4 (the Lead Hunt, 22 Sep 2026): a lead spotted in the street — who
-- captured it, when, and the photos kept for the listing draft. Written by hand.
ALTER TABLE "Lead"
    ADD COLUMN "capturedByAgentId" TEXT,
    ADD COLUMN "capturedAt" TIMESTAMP(3),
    ADD COLUMN "photoFileIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "Lead_capturedByAgentId_capturedAt_idx" ON "Lead"("capturedByAgentId", "capturedAt");
