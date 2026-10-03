-- CP-1 (agent compensation): what an agent is paid, how much of their work
-- that pay covers, and when their onboarding actually finished.
--
-- `AgentCompensation` is effective-dated like `IncentiveRate`, so a past month
-- is costed at the salary in force then. `dailyQuota` is the salary-covered
-- work of one Indian calendar day, which is why a day nobody works needs no
-- attendance record: it simply has no onboardings. `workingDaysPerMonth`
-- prices the commission and is never read as attendance.
--
-- `Publisher.onboardingCompletedAt` is the moment onboarding finished, as
-- distinct from `onboardedAt` (the door the account came through). Rows that
-- were already complete are backfilled from the best stamp they carry, and
-- the README says those are approximate.

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentCompensation" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "monthlySalary" DECIMAL(14,2) NOT NULL,
    "dailyQuota" INTEGER NOT NULL,
    "workingDaysPerMonth" INTEGER NOT NULL DEFAULT 26,
    "commissionUpliftPct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCompensation_agentId_effectiveFrom_idx" ON "AgentCompensation"("agentId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AgentCompensation_effectiveFrom_idx" ON "AgentCompensation"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "AgentCompensation" ADD CONSTRAINT "AgentCompensation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: publishers already through onboarding get the best date on the
-- row. Approximate by construction, and dated before this migration so a
-- report can tell a backfilled value from a stamped one.
UPDATE "Publisher"
SET "onboardingCompletedAt" = COALESCE("onboardedAt", "claimedAt", "createdAt")
WHERE "onboardingStatus" = 'ONBOARDING_COMPLETE' AND "onboardingCompletedAt" IS NULL;
