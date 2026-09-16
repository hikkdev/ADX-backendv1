-- DR 07 wave 6: the rating snapshot the cohort percentile is read from.
CREATE TABLE "AgentRating" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "city" TEXT,
    "score" DECIMAL(3,2),
    "completionRate" DECIMAL(5,4),
    "onTimeRate" DECIMAL(5,4),
    "rejectionRate" DECIMAL(5,4),
    "sample" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRating_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRating_agentId_key" ON "AgentRating"("agentId");
CREATE INDEX "AgentRating_city_score_idx" ON "AgentRating"("city", "score");

ALTER TABLE "AgentRating" ADD CONSTRAINT "AgentRating_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
