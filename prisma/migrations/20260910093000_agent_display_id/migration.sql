-- Agents are created in the admin panel now, in person, and get the same
-- human-readable identifier the other parties carry — AGT-1009-2601 — so an
-- agent can be named on a grant log or a payout the way a publisher is on an
-- agreement. Nullable because existing profiles predate it; backfilling them
-- is the identifiers module's job, not the migration's.

-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN "displayId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentProfile_displayId_key" ON "AgentProfile"("displayId");
