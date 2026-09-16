-- Lot D (Q44/Q120/Q7/Q139): ops-only creative moderation with a hard gate on
-- print and launch; interactions on the ADX page; QR tracking as the default.
ALTER TYPE "CreativeStatus" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "CreativeStatus" ADD VALUE 'AWAITING_ADVERTISER';
ALTER TYPE "TrackingEventType" ADD VALUE 'VIEW';
ALTER TYPE "TrackingEventType" ADD VALUE 'CTA_CLICK';
ALTER TYPE "TrackingEventType" ADD VALUE 'FORM_SUBMIT';

ALTER TABLE "CampaignCreative"
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "checks" JSONB,
  ADD COLUMN "resubmissionOfId" TEXT,
  ADD COLUMN "designedByAdx" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "advertiserAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "advertiserAcceptedById" TEXT,
  ADD COLUMN "trackingCodeId" TEXT;
CREATE INDEX "CampaignCreative_status_submittedAt_idx" ON "CampaignCreative"("status", "submittedAt");

-- Artwork uploaded before the desk existed on campaigns already in flight is
-- grandfathered (question 120), so no running campaign is frozen by the gate.
UPDATE "CampaignCreative" c SET "status" = 'APPROVED', "reviewNote" = 'Grandfathered: uploaded before creative moderation (Lot D)', "reviewedAt" = CURRENT_TIMESTAMP
  FROM "Campaign" k WHERE c."campaignId" = k."id" AND c."status" = 'UPLOADED' AND k."status" IN ('SCHEDULED', 'LIVE', 'COMPLETED');

ALTER TABLE "TrackingEvent"
  ADD COLUMN "hourIst" INTEGER,
  ADD COLUMN "ctaLabel" TEXT;
ALTER TABLE "Campaign" ALTER COLUMN "trackingMethod" SET DEFAULT 'QR_OR_DEEPLINK';
