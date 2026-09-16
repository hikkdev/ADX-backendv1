-- DR 05 wave 4: milestones that move, rewards that pay.
--
-- `rewardAmount` was one of two Float money columns in the schema; money is
-- Decimal everywhere else. A template gains a window and a start so the board
-- can print "Due in 10 days" and "Starts in 5 days", and an unlock precondition
-- so it can draw LOCKED. An agent's row gains the claim: the moment and the
-- AgentIncentive it produced, exactly once.

-- Float → Decimal. Postgres casts double precision to numeric implicitly.
ALTER TABLE "MilestoneTemplate" ALTER COLUMN "rewardAmount" TYPE DECIMAL(14,2);
ALTER TABLE "MilestoneTemplate" ALTER COLUMN "rewardAmount" SET DEFAULT 0;

ALTER TABLE "MilestoneTemplate"
  ADD COLUMN "windowDays" INTEGER,
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "unlockAfter" INTEGER,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "MilestoneTemplate"
  ADD CONSTRAINT "MilestoneTemplate_reward_not_negative" CHECK ("rewardAmount" >= 0),
  ADD CONSTRAINT "MilestoneTemplate_target_positive" CHECK ("target" > 0),
  ADD CONSTRAINT "MilestoneTemplate_window_positive" CHECK ("windowDays" IS NULL OR "windowDays" > 0),
  ADD CONSTRAINT "MilestoneTemplate_unlock_not_negative" CHECK ("unlockAfter" IS NULL OR "unlockAfter" >= 0);

ALTER TABLE "AgentMilestone"
  ADD COLUMN "computedAt" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "incentiveId" TEXT;

CREATE UNIQUE INDEX "AgentMilestone_incentiveId_key" ON "AgentMilestone"("incentiveId");

-- A claim needs a completion, and a claim is the incentive it recorded.
ALTER TABLE "AgentMilestone"
  ADD CONSTRAINT "AgentMilestone_claims_when_done" CHECK ("claimedAt" IS NULL OR "completedAt" IS NOT NULL),
  ADD CONSTRAINT "AgentMilestone_claim_is_recorded" CHECK (("claimedAt" IS NULL) = ("incentiveId" IS NULL));
