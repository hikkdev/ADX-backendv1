-- VA (23 Sep 2026): the vision lot.
--
-- CreativeAnalysis: what the vision model said about an artwork, a row per
-- run, never a decision. CompetitorSighting: a competitor's hoarding an agent
-- photographed in the street, for analysis and for a training corpus.
-- CampaignCreative.perceptualHash: the 64-bit difference hash "is this
-- artwork unique" is measured with.
--
-- The four DROP INDEX lines the diff emits are pre-existing drift between the
-- database and the schema file and are deliberately not applied here.

-- AlterTable
ALTER TABLE "CampaignCreative" ADD COLUMN     "perceptualHash" TEXT;

-- CreateTable
CREATE TABLE "CreativeAnalysis" (
    "id" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "appropriate" TEXT NOT NULL,
    "appropriateReason" TEXT,
    "relevant" TEXT NOT NULL,
    "relevantReason" TEXT,
    "legal" TEXT NOT NULL,
    "legalReason" TEXT,
    "rating" TEXT NOT NULL,
    "ratingReason" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "unique" BOOLEAN,
    "nearestCreativeId" TEXT,
    "nearestDistance" INTEGER,
    "raw" JSONB,
    "requestedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSighting" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "photoFileId" TEXT NOT NULL,
    "photoUrl" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT,
    "format" TEXT,
    "note" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "address" TEXT,
    "city" TEXT,
    "cityId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "analysis" JSONB,
    "analysedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSighting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeAnalysis_creativeId_createdAt_idx" ON "CreativeAnalysis"("creativeId", "createdAt");

-- CreateIndex
CREATE INDEX "CompetitorSighting_agentId_capturedAt_idx" ON "CompetitorSighting"("agentId", "capturedAt");

-- CreateIndex
CREATE INDEX "CompetitorSighting_cityId_capturedAt_idx" ON "CompetitorSighting"("cityId", "capturedAt");

-- CreateIndex
CREATE INDEX "CompetitorSighting_brand_idx" ON "CompetitorSighting"("brand");

-- AddForeignKey
ALTER TABLE "CreativeAnalysis" ADD CONSTRAINT "CreativeAnalysis_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "CampaignCreative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSighting" ADD CONSTRAINT "CompetitorSighting_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
