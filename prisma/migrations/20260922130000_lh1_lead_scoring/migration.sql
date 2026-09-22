-- LH1 (the Lead Hunt, 22 Sep 2026): score and temperature on a lead, the
-- source as a record with a learned quality, the agent's hot flag beside
-- the status. Written by hand.

CREATE TYPE "LeadTemperature" AS ENUM ('HOT', 'WARM', 'COLD');
CREATE TYPE "LeadSourceKind" AS ENUM ('IMPORT', 'FEED', 'CAPTURE', 'QR', 'INBOUND', 'REFERRAL', 'ADS', 'MANUAL');
ALTER TYPE "LeadActivityKind" ADD VALUE 'TEMPERATURE_CHANGED';

CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "LeadSourceKind" NOT NULL DEFAULT 'MANUAL',
    "label" TEXT NOT NULL,
    "quality" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "quotaPerDay" INTEGER,
    "termsAcceptedAt" TIMESTAMP(3),
    "config" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadSource_key_key" ON "LeadSource"("key");
CREATE INDEX "LeadSource_kind_isActive_idx" ON "LeadSource"("kind", "isActive");

ALTER TABLE "Lead"
    ADD COLUMN "score" INTEGER,
    ADD COLUMN "temperature" "LeadTemperature",
    ADD COLUMN "scoreReasons" JSONB,
    ADD COLUMN "scoreComputedAt" TIMESTAMP(3),
    ADD COLUMN "estimatedValue" DECIMAL(14,2),
    ADD COLUMN "agentFlaggedHotAt" TIMESTAMP(3),
    ADD COLUMN "lastTouchedAt" TIMESTAMP(3),
    ADD COLUMN "sourceId" TEXT;

CREATE INDEX "Lead_temperature_status_idx" ON "Lead"("temperature", "status");
CREATE INDEX "Lead_sourceId_idx" ON "Lead"("sourceId");

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One LeadSource per distinct legacy label. The console's one-at-a-time door
-- and the imports carried whatever ops typed; the waitlist wrote WAITLIST.
INSERT INTO "LeadSource" ("id", "key", "kind", "label", "quality", "updatedAt")
SELECT
    'lsrc_' || md5(lower(trim("source"))),
    lower(trim("source")),
    CASE
        WHEN lower(trim("source")) = 'waitlist' THEN 'INBOUND'::"LeadSourceKind"
        WHEN lower(trim("source")) LIKE '%referr%' THEN 'REFERRAL'::"LeadSourceKind"
        ELSE 'IMPORT'::"LeadSourceKind"
    END,
    trim("source"),
    CASE WHEN lower(trim("source")) LIKE '%referr%' THEN 10 ELSE 5 END,
    CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "source" FROM "Lead" WHERE "source" IS NOT NULL AND trim("source") <> '') AS labels
ON CONFLICT ("key") DO NOTHING;

-- The doors every later lead comes through, so the service never races to create them.
INSERT INTO "LeadSource" ("id", "key", "kind", "label", "quality", "updatedAt") VALUES
    ('lsrc_manual', 'manual', 'MANUAL', 'Added at the desk', 5, CURRENT_TIMESTAMP),
    ('lsrc_import', 'import', 'IMPORT', 'Ops import', 5, CURRENT_TIMESTAMP),
    ('lsrc_capture', 'capture', 'CAPTURE', 'Spotted in the street', 6, CURRENT_TIMESTAMP),
    ('lsrc_qr', 'qr', 'QR', 'QR poster', 8, CURRENT_TIMESTAMP),
    ('lsrc_inbound', 'inbound', 'INBOUND', 'Inbound (web, missed call, WhatsApp)', 9, CURRENT_TIMESTAMP),
    ('lsrc_referral', 'referral', 'REFERRAL', 'Referred by a customer', 12, CURRENT_TIMESTAMP),
    ('lsrc_ads', 'ads', 'ADS', 'Lead-form ads', 9, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

UPDATE "Lead" l
SET "sourceId" = s."id"
FROM "LeadSource" s
WHERE l."source" IS NOT NULL AND lower(trim(l."source")) = s."key" AND l."sourceId" IS NULL;

-- Today's HOT status becomes the agent's flag (worth +10 for 14 days from
-- now); the status falls back to what the lifecycle knows — CONTACTED once
-- somebody has spoken to them, NEW otherwise. The pill reads the temperature.
UPDATE "Lead"
SET "agentFlaggedHotAt" = CURRENT_TIMESTAMP,
    "status" = CASE WHEN "firstContactedAt" IS NOT NULL THEN 'CONTACTED'::"LeadStatus" ELSE 'NEW'::"LeadStatus" END
WHERE "status" = 'HOT';

-- The recency signal starts from the last thing that happened to the lead.
UPDATE "Lead" l
SET "lastTouchedAt" = COALESCE(
    (SELECT MAX(a."createdAt") FROM "LeadActivity" a WHERE a."leadId" = l."id" AND a."kind" <> 'IMPORTED'),
    l."firstContactedAt",
    l."createdAt"
)
WHERE l."lastTouchedAt" IS NULL;
