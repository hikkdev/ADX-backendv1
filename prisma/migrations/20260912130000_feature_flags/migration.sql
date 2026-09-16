-- Lot A (Q32): features that ship dark. The first three keys are the ones the
-- owner said should exist but not be recommended — instant booking,
-- multi-market campaigns, publisher-visible spot figures — all seeded off.

CREATE TABLE "FeatureFlag" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
  "description" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "FeatureFlagChange" (
  "id" TEXT NOT NULL,
  "flagKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "rolloutPercent" INTEGER NOT NULL,
  "byUserId" TEXT NOT NULL,
  "note" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeatureFlagChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FeatureFlagChange_flagKey_at_idx" ON "FeatureFlagChange"("flagKey", "at");
ALTER TABLE "FeatureFlagChange"
  ADD CONSTRAINT "FeatureFlagChange_flagKey_fkey" FOREIGN KEY ("flagKey") REFERENCES "FeatureFlag"("key") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_rollout_range"
  CHECK ("rolloutPercent" >= 0 AND "rolloutPercent" <= 100);

INSERT INTO "FeatureFlag" ("key", "enabled", "rolloutPercent", "description", "updatedAt") VALUES
  ('instant-booking', false, 100, 'Publishers may opt a listing into automatic acceptance (Q6): allowed, not recommended.', CURRENT_TIMESTAMP),
  ('multi-market-campaigns', false, 100, 'A campaign may target more than one market (Q8): allowed, warned against.', CURRENT_TIMESTAMP),
  ('publisher-spot-insights', false, 100, 'Publishers see the advertiser''s per-spot figures on their bookings (Q9): kept present, off until there is data.', CURRENT_TIMESTAMP);
