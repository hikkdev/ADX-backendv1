-- LH9 (the Lead Hunt, analytics): the recycle stamps the Leads overview's
-- recycle yield and LH11's board flag read, and the three indexes the
-- overview's window aggregates group on.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "recycleCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recycledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Lead_convertedAt_idx" ON "Lead"("convertedAt");

-- CreateIndex
CREATE INDEX "Lead_activatedAt_idx" ON "Lead"("activatedAt");

-- CreateIndex
CREATE INDEX "Lead_recycledAt_idx" ON "Lead"("recycledAt");
