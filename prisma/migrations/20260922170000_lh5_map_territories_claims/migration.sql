-- LH5 (the Lead Hunt, 22 Sep 2026): territories that route new leads, priority
-- zones with a top-up under a budget, claims with a hold. Written by hand.

CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "side" "LeadSide" NOT NULL,
    "polygon" JSONB NOT NULL,
    "south" DOUBLE PRECISION NOT NULL,
    "west" DOUBLE PRECISION NOT NULL,
    "north" DOUBLE PRECISION NOT NULL,
    "east" DOUBLE PRECISION NOT NULL,
    "agentId" TEXT NOT NULL,
    "city" TEXT,
    "cityId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Territory_side_isActive_idx" ON "Territory"("side", "isActive");
CREATE INDEX "Territory_agentId_idx" ON "Territory"("agentId");

CREATE TABLE "PriorityZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "side" "LeadSide",
    "polygon" JSONB,
    "south" DOUBLE PRECISION,
    "west" DOUBLE PRECISION,
    "north" DOUBLE PRECISION,
    "east" DOUBLE PRECISION,
    "category" TEXT,
    "topUp" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "budgetCap" DECIMAL(14,2),
    "spent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriorityZone_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriorityZone_isActive_startsAt_endsAt_idx" ON "PriorityZone"("isActive", "startsAt", "endsAt");

CREATE TABLE "LeadClaim" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "LeadClaim_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeadClaim_leadId_claimedAt_idx" ON "LeadClaim"("leadId", "claimedAt");
CREATE INDEX "LeadClaim_agentId_releasedAt_idx" ON "LeadClaim"("agentId", "releasedAt");
CREATE INDEX "LeadClaim_expiresAt_idx" ON "LeadClaim"("expiresAt");
ALTER TABLE "LeadClaim" ADD CONSTRAINT "LeadClaim_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead"
    ADD COLUMN "claimedByAgentId" TEXT,
    ADD COLUMN "claimExpiresAt" TIMESTAMP(3),
    ADD COLUMN "territoryId" TEXT;
CREATE INDEX "Lead_claimedByAgentId_claimExpiresAt_idx" ON "Lead"("claimedByAgentId", "claimExpiresAt");
CREATE INDEX "Lead_territoryId_idx" ON "Lead"("territoryId");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
