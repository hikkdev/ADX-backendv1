-- Lot B (Q10/Q38): one commission rate, resolved once at authorisation and
-- stamped on the booking. CommissionRate can now be keyed by the pricing
-- engine's media type and by a rental slab on the per-day media value; the
-- accrual reads the stamp and never a constant.
ALTER TABLE "CommissionRate"
  ADD COLUMN "mediaTypeId" TEXT,
  ADD COLUMN "minMediaValue" DECIMAL(14,2),
  ADD COLUMN "maxMediaValue" DECIMAL(14,2);
CREATE INDEX "CommissionRate_isActive_mediaTypeId_idx" ON "CommissionRate"("isActive", "mediaTypeId");
ALTER TABLE "CommissionRate"
  ADD CONSTRAINT "CommissionRate_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionRate" ADD CONSTRAINT "CommissionRate_slab_ordered"
  CHECK ("minMediaValue" IS NULL OR "maxMediaValue" IS NULL OR "minMediaValue" <= "maxMediaValue");

ALTER TABLE "CampaignSpot"
  ADD COLUMN "commissionPct" DECIMAL(5,4),
  ADD COLUMN "commissionSource" TEXT;
ALTER TABLE "EarningAccrual" ADD COLUMN "commissionSource" TEXT;

-- The platform default becomes a row, at the owner's chosen 15% (question 108).
INSERT INTO "CommissionRate" ("id", "category", "ratePct", "note", "isActive", "createdAt", "updatedAt")
SELECT 'commission_default_platform', NULL, 0.1500, 'Platform default (Lot B, question 108): 15% of the media value the advertiser is billed for.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "CommissionRate" WHERE "category" IS NULL AND "mediaTypeId" IS NULL AND "isActive" = true);
