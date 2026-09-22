-- AG-4 (20 Sep 2026): screening (interviews, the desk's screen tick, the
-- assessment as a training module kind), a curriculum per side, the paper
-- expiry sweep, verification seams (Cashfree vehicle RC and bank), and a
-- vehicle put up as a listing. Written by hand like AG-1.

-- Enums
ALTER TYPE "AgentDocumentStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "ListingDocumentKind" ADD VALUE 'VEHICLE_RC';
CREATE TYPE "DocumentVerificationVia" AS ENUM ('MANUAL', 'CASHFREE_VRS', 'CASHFREE_BANK');
CREATE TYPE "AgentInterviewMode" AS ENUM ('IN_PERSON', 'PHONE', 'VIDEO');
CREATE TYPE "AgentInterviewOutcome" AS ENUM ('SCHEDULED', 'PASSED', 'FAILED', 'NO_SHOW', 'CANCELLED');
CREATE TYPE "TrainingAudience" AS ENUM ('ALL', 'PUBLISHER_AGENT', 'ADVERTISER_AGENT');
CREATE TYPE "TrainingModuleKind" AS ENUM ('LESSON', 'ASSESSMENT');

-- AgentProfile: the screen tick and the hold memory.
ALTER TABLE "AgentProfile"
  ADD COLUMN "screenedAt" TIMESTAMP(3),
  ADD COLUMN "screenedById" TEXT,
  ADD COLUMN "screeningNote" TEXT,
  ADD COLUMN "heldFromStage" "AgentStage";

-- AgentDocument: expiry reminders and verification.
ALTER TABLE "AgentDocument"
  ADD COLUMN "expiryRemindedAt" TIMESTAMP(3),
  ADD COLUMN "expiryReminderDays" INTEGER,
  ADD COLUMN "expiredAt" TIMESTAMP(3),
  ADD COLUMN "verifiedVia" "DocumentVerificationVia",
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verificationPayload" JSONB;

-- AgentInterview
CREATE TABLE "AgentInterview" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "round" INTEGER NOT NULL DEFAULT 1,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "mode" "AgentInterviewMode" NOT NULL DEFAULT 'IN_PERSON',
  "location" TEXT,
  "interviewerId" TEXT,
  "outcome" "AgentInterviewOutcome" NOT NULL DEFAULT 'SCHEDULED',
  "marks" INTEGER,
  "notes" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decidedById" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentInterview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentInterview_agentId_round_idx" ON "AgentInterview"("agentId", "round");
CREATE INDEX "AgentInterview_scheduledAt_idx" ON "AgentInterview"("scheduledAt");
ALTER TABLE "AgentInterview" ADD CONSTRAINT "AgentInterview_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentInterview" ADD CONSTRAINT "AgentInterview_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- TrainingModule: audience, kind, clock.
ALTER TABLE "TrainingModule"
  ADD COLUMN "audience" "TrainingAudience" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "kind" "TrainingModuleKind" NOT NULL DEFAULT 'LESSON',
  ADD COLUMN "timeLimitMins" INTEGER;

-- Listing: a vehicle as a spot.
ALTER TABLE "Listing"
  ADD COLUMN "vehicleNumber" TEXT,
  ADD COLUMN "vehicleRcVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "vehicleRcPayload" JSONB;
