-- AG-5 (21 Sep 2026): routing by grade (the advertiser's band, the lead's
-- importance), fleet partners with their invites and the provenance on the
-- agent, and the exit's document purge stamp. Written by hand like AG-1.

CREATE TYPE "LeadImportance" AS ENUM ('STANDARD', 'KEY', 'ENTERPRISE');
CREATE TYPE "FleetInviteStatus" AS ENUM ('SENT', 'APPLIED', 'ACTIVATED');

ALTER TABLE "Advertiser" ADD COLUMN "sizeBand" "PartySizeBand" NOT NULL DEFAULT 'INDIVIDUAL';
ALTER TABLE "Lead" ADD COLUMN "importance" "LeadImportance" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "AgentProfile"
  ADD COLUMN "fleetPartnerId" TEXT,
  ADD COLUMN "documentsPurgedAt" TIMESTAMP(3);
CREATE INDEX "AgentProfile_fleetPartnerId_idx" ON "AgentProfile"("fleetPartnerId");

CREATE TABLE "FleetPartner" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'OTHER',
  "contactName" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "city" TEXT,
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FleetPartner_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FleetPartner_isActive_name_idx" ON "FleetPartner"("isActive", "name");

CREATE TABLE "FleetInvite" (
  "id" TEXT NOT NULL,
  "partnerId" TEXT NOT NULL,
  "mobile" TEXT NOT NULL,
  "name" TEXT,
  "status" "FleetInviteStatus" NOT NULL DEFAULT 'SENT',
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentById" TEXT,
  "agentId" TEXT,
  "appliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FleetInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetInvite_partnerId_mobile_key" ON "FleetInvite"("partnerId", "mobile");
CREATE INDEX "FleetInvite_mobile_idx" ON "FleetInvite"("mobile");
CREATE INDEX "FleetInvite_status_idx" ON "FleetInvite"("status");
ALTER TABLE "FleetInvite" ADD CONSTRAINT "FleetInvite_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetInvite" ADD CONSTRAINT "FleetInvite_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
