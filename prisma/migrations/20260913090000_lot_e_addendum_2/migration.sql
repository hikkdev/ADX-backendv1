-- Lot E addendum 2: what the Lot E packages asked for once they had built.
ALTER TYPE "AiGenerationKind" ADD VALUE 'LANDING_PAGE';
ALTER TABLE "AiGeneration" ALTER COLUMN "publisherId" DROP NOT NULL;
ALTER TABLE "AiGeneration" ADD COLUMN "advertiserId" TEXT;
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AiGeneration_advertiserId_subjectKey_idx" ON "AiGeneration"("advertiserId", "subjectKey");
ALTER TABLE "PriceApproval" ADD COLUMN "heldByRunningOrder" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PublisherKyc" ADD COLUMN "manifestVersion" INTEGER;
ALTER TABLE "AdvertiserKyc" ADD COLUMN "manifestVersion" INTEGER;
ALTER TABLE "LandingPage" ADD CONSTRAINT "LandingPage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
