-- LH2 (the Lead Hunt, 22 Sep 2026): the twelve pipeline stages beside the
-- status, the loss reasons, the catch and the trailing reward, the recycle
-- date, the channel attribution. Written by hand.

CREATE TYPE "LeadStage" AS ENUM ('SOURCED', 'SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED', 'CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED', 'LOST');
CREATE TYPE "LeadLostReason" AS ENUM ('NOT_INTERESTED', 'WRONG_CONTACT', 'COMPETITOR', 'PRICE', 'TIMING', 'OTHER');

ALTER TYPE "LeadActivityKind" ADD VALUE 'STAGE_CHANGED';
ALTER TYPE "LeadActivityKind" ADD VALUE 'ENGAGED';
ALTER TYPE "LeadActivityKind" ADD VALUE 'PROPOSAL_SENT';
ALTER TYPE "LeadActivityKind" ADD VALUE 'LINK_OPENED';
ALTER TYPE "LeadActivityKind" ADD VALUE 'TOUCH_LOGGED';

ALTER TABLE "Lead"
    ADD COLUMN "stage" "LeadStage" NOT NULL DEFAULT 'SOURCED',
    ADD COLUMN "stageChangedAt" TIMESTAMP(3),
    ADD COLUMN "lostReason" "LeadLostReason",
    ADD COLUMN "lostNote" TEXT,
    ADD COLUMN "activatedAt" TIMESTAMP(3),
    ADD COLUMN "retainedAt" TIMESTAMP(3),
    ADD COLUMN "recycleAt" TIMESTAMP(3),
    ADD COLUMN "attribution" JSONB;

CREATE INDEX "Lead_stage_side_idx" ON "Lead"("stage", "side");
CREATE INDEX "Lead_recycleAt_idx" ON "Lead"("recycleAt");

-- Every existing lead lands on the stage its status and score imply.
UPDATE "Lead" SET
    "stage" = CASE
        WHEN "status" = 'CONVERTED' THEN 'CONVERTED'::"LeadStage"
        WHEN "status" = 'LOST' THEN 'LOST'::"LeadStage"
        WHEN "status" = 'VISIT_BOOKED' THEN 'VISIT_BOOKED'::"LeadStage"
        WHEN "firstContactedAt" IS NOT NULL THEN 'CONTACTED'::"LeadStage"
        WHEN "assignedAgentId" IS NOT NULL THEN 'CLAIMED'::"LeadStage"
        WHEN "score" IS NOT NULL THEN 'SCORED'::"LeadStage"
        ELSE 'SOURCED'::"LeadStage"
    END,
    "stageChangedAt" = COALESCE("convertedAt", "firstContactedAt", "scoreComputedAt", "createdAt"),
    "lostReason" = CASE WHEN "status" = 'LOST' THEN 'OTHER'::"LeadLostReason" ELSE NULL END,
    "lostNote" = CASE WHEN "status" = 'LOST' THEN 'Closed before the pipeline stages existed' ELSE NULL END;
