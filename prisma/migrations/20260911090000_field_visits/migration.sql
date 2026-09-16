-- DR 06 wave 3: field visits — a trip that is not a step on an order.
--
-- The platform's only visit was OrderMilestone, whose orderId is non-nullable,
-- so an onboarding call on a lead or a renewal call on an advertiser could not
-- be recorded at all. This table holds those; a site visit on an order stays an
-- OrderMilestone and is folded into the agent's day by the service.

CREATE TYPE "FieldVisitKind" AS ENUM ('ONBOARDING', 'RENEWAL', 'FOLLOW_UP', 'SURVEY');

CREATE TYPE "FieldVisitStatus" AS ENUM (
  'REQUESTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "FieldVisit" (
  "id"                TEXT NOT NULL,
  "displayId"         TEXT,
  "kind"              "FieldVisitKind" NOT NULL,
  "status"            "FieldVisitStatus" NOT NULL DEFAULT 'REQUESTED',
  "agentId"           TEXT NOT NULL,
  "leadId"            TEXT,
  "publisherId"       TEXT,
  "advertiserId"      TEXT,
  "businessName"      TEXT NOT NULL,
  "locality"          TEXT,
  "city"              TEXT,
  "latitude"          DOUBLE PRECISION,
  "longitude"         DOUBLE PRECISION,
  "offerExpiresAt"    TIMESTAMP(3),
  "scheduledFor"      TIMESTAMP(3),
  "startedAt"         TIMESTAMP(3),
  "completedAt"       TIMESTAMP(3),
  "declinedReason"    TEXT,
  "earnedAmount"      DECIMAL(14,2),
  "incentiveId"       TEXT,
  "notes"             TEXT,
  "requestedByUserId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FieldVisit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FieldVisit_displayId_key" ON "FieldVisit"("displayId");
CREATE UNIQUE INDEX "FieldVisit_incentiveId_key" ON "FieldVisit"("incentiveId");
CREATE INDEX "FieldVisit_agentId_status_scheduledFor_idx" ON "FieldVisit"("agentId", "status", "scheduledFor");
CREATE INDEX "FieldVisit_status_scheduledFor_idx" ON "FieldVisit"("status", "scheduledFor");
CREATE INDEX "FieldVisit_city_scheduledFor_idx" ON "FieldVisit"("city", "scheduledFor");

ALTER TABLE "FieldVisit"
  ADD CONSTRAINT "FieldVisit_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FieldVisit"
  ADD CONSTRAINT "FieldVisit_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A visit is to exactly one party.
ALTER TABLE "FieldVisit"
  ADD CONSTRAINT "FieldVisit_one_party"
  CHECK (
    (CASE WHEN "leadId" IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN "publisherId" IS NULL THEN 0 ELSE 1 END)
    + (CASE WHEN "advertiserId" IS NULL THEN 0 ELSE 1 END) = 1
  );

-- A completed visit says when, and only a completed visit earns.
ALTER TABLE "FieldVisit"
  ADD CONSTRAINT "FieldVisit_completed_is_dated"
  CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));

ALTER TABLE "FieldVisit"
  ADD CONSTRAINT "FieldVisit_earns_when_done"
  CHECK ("earnedAmount" IS NULL OR "status" = 'COMPLETED');

-- VST-#### on a visit, from the one counter.
ALTER TYPE "PartyType" ADD VALUE IF NOT EXISTS 'VISIT';
