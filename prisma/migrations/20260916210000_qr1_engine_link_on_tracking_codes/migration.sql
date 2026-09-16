-- QR-1: the QR engine's hold on a campaign tracking code.
--
-- Additive. A code with no engine link is what every code was before: the
-- hoarding carries ADX's own /t/ URL and nothing here is read.
ALTER TABLE "CampaignTrackingCode" ADD COLUMN "engineCodeId" TEXT;
ALTER TABLE "CampaignTrackingCode" ADD COLUMN "shortUrl" TEXT;
ALTER TABLE "CampaignTrackingCode" ADD COLUMN "engineLinkedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CampaignTrackingCode_engineCodeId_key" ON "CampaignTrackingCode"("engineCodeId");
