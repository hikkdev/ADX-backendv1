-- LT-1 (live agent tracking, 22 Sep 2026): the trail an agent leaves on a
-- job — the fixes behind the live map's marker and the order's timeline.
-- The live position itself lives in Redis. Written by hand.

CREATE TYPE "TrailKind" AS ENUM ('ORDER', 'MILESTONE', 'FIELD_VISIT');

CREATE TABLE "AgentTrail" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "TrailKind" NOT NULL,
    "contextId" TEXT NOT NULL,
    "orderId" TEXT,
    "destinationLat" DOUBLE PRECISION,
    "destinationLng" DOUBLE PRECISION,
    "destinationLabel" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFixAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "pointCount" INTEGER NOT NULL DEFAULT 0,
    "distanceM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTrail_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentLocationPoint" (
    "id" TEXT NOT NULL,
    "trailId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentLocationPoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTrail_agentId_kind_contextId_key" ON "AgentTrail"("agentId", "kind", "contextId");
CREATE INDEX "AgentTrail_orderId_idx" ON "AgentTrail"("orderId");
CREATE INDEX "AgentTrail_agentId_startedAt_idx" ON "AgentTrail"("agentId", "startedAt");
CREATE INDEX "AgentTrail_endedAt_idx" ON "AgentTrail"("endedAt");
CREATE INDEX "AgentLocationPoint_trailId_at_idx" ON "AgentLocationPoint"("trailId", "at");
CREATE INDEX "AgentLocationPoint_at_idx" ON "AgentLocationPoint"("at");

ALTER TABLE "AgentTrail" ADD CONSTRAINT "AgentTrail_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentLocationPoint" ADD CONSTRAINT "AgentLocationPoint_trailId_fkey" FOREIGN KEY ("trailId") REFERENCES "AgentTrail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
