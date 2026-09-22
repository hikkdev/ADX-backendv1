-- LH3 (the Lead Hunt, 22 Sep 2026): directory feed runs, the webhook /
-- feed idempotence key on a lead, the referral link and the referral, and
-- leads as a party on the two-step importer. Written by hand.

ALTER TYPE "ImportParty" ADD VALUE 'LEAD';

CREATE TYPE "LeadFeedRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED', 'QUOTA');
CREATE TYPE "ReferrerKind" AS ENUM ('PUBLISHER', 'ADVERTISER', 'AGENT');

CREATE TABLE "LeadFeedRun" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "requestedById" TEXT,
    "side" "LeadSide" NOT NULL,
    "category" TEXT NOT NULL,
    "city" TEXT,
    "polygon" JSONB,
    "limit" INTEGER NOT NULL,
    "status" "LeadFeedRunStatus" NOT NULL DEFAULT 'RUNNING',
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "LeadFeedRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeadFeedRun_sourceId_startedAt_idx" ON "LeadFeedRun"("sourceId", "startedAt");
ALTER TABLE "LeadFeedRun" ADD CONSTRAINT "LeadFeedRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
    ADD COLUMN "externalKey" TEXT,
    ADD COLUMN "feedRunId" TEXT;
CREATE UNIQUE INDEX "Lead_externalKey_key" ON "Lead"("externalKey");
CREATE INDEX "Lead_feedRunId_idx" ON "Lead"("feedRunId");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_feedRunId_fkey" FOREIGN KEY ("feedRunId") REFERENCES "LeadFeedRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReferralLink" (
    "id" TEXT NOT NULL,
    "referrerKind" "ReferrerKind" NOT NULL,
    "referrerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralLink_code_key" ON "ReferralLink"("code");
CREATE UNIQUE INDEX "ReferralLink_referrerKind_referrerId_key" ON "ReferralLink"("referrerKind", "referrerId");

CREATE TABLE "LeadReferral" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "referrerKind" "ReferrerKind" NOT NULL,
    "referrerId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "creditAmount" DECIMAL(14,2),
    "creditedAt" TIMESTAMP(3),
    "walletEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadReferral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadReferral_leadId_key" ON "LeadReferral"("leadId");
CREATE INDEX "LeadReferral_referrerKind_referrerId_idx" ON "LeadReferral"("referrerKind", "referrerId");
ALTER TABLE "LeadReferral" ADD CONSTRAINT "LeadReferral_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ReferralLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadReferral" ADD CONSTRAINT "LeadReferral_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The directory feeds as sources, off until their terms are confirmed and
-- credentials exist; Google Places rides the maps seam's server key.
INSERT INTO "LeadSource" ("id", "key", "kind", "label", "quality", "quotaPerDay", "isActive", "updatedAt") VALUES
    ('lsrc_feed_google_places', 'google-places', 'FEED', 'Google Places', 4, 500, true, CURRENT_TIMESTAMP),
    ('lsrc_feed_justdial', 'justdial', 'FEED', 'JustDial', 3, 200, false, CURRENT_TIMESTAMP),
    ('lsrc_feed_indiamart', 'indiamart', 'FEED', 'IndiaMART', 3, 200, false, CURRENT_TIMESTAMP),
    ('lsrc_feed_mca', 'mca', 'FEED', 'MCA company directory', 3, 200, false, CURRENT_TIMESTAMP),
    ('lsrc_feed_gst', 'gst', 'FEED', 'GST directory', 3, 200, false, CURRENT_TIMESTAMP),
    ('lsrc_feed_rera', 'rera', 'FEED', 'RERA projects', 4, 200, false, CURRENT_TIMESTAMP),
    ('lsrc_web', 'web', 'INBOUND', 'Website form', 9, NULL, true, CURRENT_TIMESTAMP),
    ('lsrc_site_qr', 'site-qr', 'QR', 'SITE QR poster', 8, NULL, true, CURRENT_TIMESTAMP),
    ('lsrc_agent_qr', 'agent-qr', 'QR', 'Agent referral card', 8, NULL, true, CURRENT_TIMESTAMP),
    ('lsrc_ads_meta', 'meta-lead-ads', 'ADS', 'Meta lead ads', 9, NULL, true, CURRENT_TIMESTAMP),
    ('lsrc_ads_google', 'google-lead-forms', 'ADS', 'Google Ads lead forms', 9, NULL, true, CURRENT_TIMESTAMP),
    ('lsrc_ads_linkedin', 'linkedin-lead-gen', 'ADS', 'LinkedIn Lead Gen Forms', 9, NULL, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
