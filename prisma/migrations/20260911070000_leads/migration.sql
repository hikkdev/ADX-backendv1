-- DR 06 wave 2: leads — the prospect a field agent goes to see.
--
-- The platform had no such record. `AgentDashboard` declared a `LeadCluster`
-- shape and returned `leads: []`, with a test pinning the empty list as
-- correct "until a lead model exists". This is that model.

CREATE TYPE "LeadSide" AS ENUM ('PUBLISHER', 'ADVERTISER');

CREATE TYPE "LeadStatus" AS ENUM (
  'NEW',
  'CONTACTED',
  'HOT',
  'VISIT_BOOKED',
  'CONVERTED',
  'LOST'
);

CREATE TYPE "LeadActivityKind" AS ENUM (
  'IMPORTED',
  'CALLED',
  'MESSAGED',
  'NOTE',
  'VISIT_BOOKED',
  'VISIT_DONE',
  'STATUS_CHANGED',
  'FOLLOW_UP'
);

CREATE TABLE "Lead" (
  "id"                    TEXT NOT NULL,
  "displayId"             TEXT,
  "side"                  "LeadSide" NOT NULL,
  "businessName"          TEXT NOT NULL,
  "category"              TEXT,
  "contactName"           TEXT,
  "phone"                 TEXT,
  "email"                 TEXT,
  "address"               TEXT,
  "locality"              TEXT,
  "city"                  TEXT,
  "latitude"              DOUBLE PRECISION,
  "longitude"             DOUBLE PRECISION,
  "status"                "LeadStatus" NOT NULL DEFAULT 'NEW',
  "estimatedCommission"   DECIMAL(14,2),
  "interest"              TEXT,
  "source"                TEXT,
  "bestTimeFrom"          TEXT,
  "bestTimeTo"            TEXT,
  "assignedAgentId"       TEXT,
  "firstContactedAt"      TIMESTAMP(3),
  "convertedPublisherId"  TEXT,
  "convertedAdvertiserId" TEXT,
  "convertedAt"           TIMESTAMP(3),
  "createdByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Lead_displayId_key" ON "Lead"("displayId");
CREATE INDEX "Lead_city_status_idx" ON "Lead"("city", "status");
CREATE INDEX "Lead_assignedAgentId_status_idx" ON "Lead"("assignedAgentId", "status");
-- The "near you" query rides this one; `Listing` carries the same pair for the
-- same reason.
CREATE INDEX "Lead_latitude_longitude_idx" ON "Lead"("latitude", "longitude");

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_assignedAgentId_fkey"
  FOREIGN KEY ("assignedAgentId") REFERENCES "AgentProfile"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A commission estimate is money and money is never negative. Nullable, because
-- a lead nobody has priced has no estimate — which is not the same as zero.
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_estimate_not_negative"
  CHECK ("estimatedCommission" IS NULL OR "estimatedCommission" >= 0);

-- A converted lead says when, and a lead that says when is converted. The pair
-- moves together or the funnel counts disagree with the timeline.
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_converted_is_dated"
  CHECK (("status" = 'CONVERTED') = ("convertedAt" IS NOT NULL));

-- A lead converts into exactly one account, never both.
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_converts_once"
  CHECK (NOT ("convertedPublisherId" IS NOT NULL AND "convertedAdvertiserId" IS NOT NULL));

CREATE TABLE "LeadActivity" (
  "id"          TEXT NOT NULL,
  "leadId"      TEXT NOT NULL,
  "actorUserId" TEXT,
  "kind"        "LeadActivityKind" NOT NULL,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadActivity_leadId_createdAt_idx" ON "LeadActivity"("leadId", "createdAt");

ALTER TABLE "LeadActivity"
  ADD CONSTRAINT "LeadActivity_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

