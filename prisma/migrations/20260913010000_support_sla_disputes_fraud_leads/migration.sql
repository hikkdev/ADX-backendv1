-- Lot D (Q53/Q54/Q56/Q91/Q92/Q93): a support desk that can say what is late,
-- a re-install that reaches an agent, fraud as a case, leads with one phone key.
ALTER TYPE "TicketStatus" ADD VALUE 'WAITING';
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

ALTER TABLE "SupportTicket"
  ADD COLUMN "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "slaFirstResponseDueAt" TIMESTAMP(3),
  ADD COLUMN "slaResolutionDueAt" TIMESTAMP(3),
  ADD COLUMN "firstRespondedAt" TIMESTAMP(3),
  ADD COLUMN "slaPausedAt" TIMESTAMP(3),
  ADD COLUMN "slaPausedMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "assignedAdminUserId" TEXT,
  ADD COLUMN "assignedAdminAt" TIMESTAMP(3),
  ADD COLUMN "team" TEXT;
CREATE INDEX "SupportTicket_priority_slaResolutionDueAt_idx" ON "SupportTicket"("priority", "slaResolutionDueAt");
ALTER TABLE "TicketMessage" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Dispute"
  ADD COLUMN "slaPausedAt" TIMESTAMP(3),
  ADD COLUMN "slaPausedMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reinstallMilestoneId" TEXT;
CREATE UNIQUE INDEX "Dispute_reinstallMilestoneId_key" ON "Dispute"("reinstallMilestoneId");
ALTER TABLE "OrderMilestone" ADD COLUMN "reinstallOfDisputeId" TEXT;

CREATE TYPE "FraudCaseStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'CONFIRMED', 'DISMISSED');
CREATE TABLE "FraudCase" (
  "id" TEXT NOT NULL,
  "displayId" TEXT,
  "subjectType" "SuspendedPartyType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" "FraudCaseStatus" NOT NULL DEFAULT 'OPEN',
  "summary" TEXT NOT NULL,
  "openedByUserId" TEXT NOT NULL,
  "assignedToUserId" TEXT,
  "disputeId" TEXT,
  "decision" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FraudCase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FraudCase_displayId_key" ON "FraudCase"("displayId");
CREATE INDEX "FraudCase_subjectType_subjectId_idx" ON "FraudCase"("subjectType", "subjectId");
CREATE INDEX "FraudCase_status_createdAt_idx" ON "FraudCase"("status", "createdAt");
ALTER TABLE "FraudCase" ADD CONSTRAINT "FraudCase_decided_is_signed"
  CHECK ("status" NOT IN ('CONFIRMED', 'DISMISSED') OR ("decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL));

CREATE TABLE "FraudCaseNote" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "byUserId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FraudCaseNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FraudCaseNote_caseId_createdAt_idx" ON "FraudCaseNote"("caseId", "createdAt");
ALTER TABLE "FraudCaseNote" ADD CONSTRAINT "FraudCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FraudCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FraudCaseEvidence" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fileId" TEXT,
  "url" TEXT,
  "note" TEXT,
  "addedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FraudCaseEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FraudCaseEvidence_caseId_idx" ON "FraudCaseEvidence"("caseId");
ALTER TABLE "FraudCaseEvidence" ADD CONSTRAINT "FraudCaseEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FraudCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead" ADD COLUMN "phoneNormalised" TEXT;
CREATE UNIQUE INDEX "Lead_phoneNormalised_key" ON "Lead"("phoneNormalised") WHERE "phoneNormalised" IS NOT NULL;
