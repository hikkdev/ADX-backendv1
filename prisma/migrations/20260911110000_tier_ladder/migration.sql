-- DR 05 wave 5: the tier ladder, made real.
--
-- `AgentProfile.tier` was a bare string nothing but a dashboard read ever
-- wrote, and the level (I/II/III) the agent sees was never stored, so the
-- console printed "BRONZE" where the phone printed "Bronze III". The tier
-- becomes an enum with its level beside it; a promotion (or a fall) is a row
-- in AgentTierEvent so the GOLD Achieved screen can fire once and the rung's
-- history is auditable; and ops can pin a tier with a reason.

CREATE TYPE "AgentTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');
CREATE TYPE "TierLevel" AS ENUM ('I', 'II', 'III');

ALTER TABLE "AgentProfile" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "AgentProfile" ALTER COLUMN "tier" TYPE "AgentTier" USING ("tier"::"AgentTier");
ALTER TABLE "AgentProfile" ALTER COLUMN "tier" SET DEFAULT 'BRONZE';

ALTER TABLE "AgentProfile"
  ADD COLUMN "tierLevel" "TierLevel" NOT NULL DEFAULT 'I',
  ADD COLUMN "tierPinnedAt" TIMESTAMP(3);

CREATE TABLE "AgentTierEvent" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "fromTier" "AgentTier" NOT NULL,
  "fromLevel" "TierLevel" NOT NULL,
  "toTier" "AgentTier" NOT NULL,
  "toLevel" "TierLevel" NOT NULL,
  "reason" TEXT NOT NULL,
  "byUserId" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  CONSTRAINT "AgentTierEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTierEvent_agentId_at_idx" ON "AgentTierEvent"("agentId", "at");

ALTER TABLE "AgentTierEvent"
  ADD CONSTRAINT "AgentTierEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A rung's bonus, priced per tier in the rate table like every other incentive.
ALTER TYPE "IncentiveEvent" ADD VALUE 'TIER_BONUS';
