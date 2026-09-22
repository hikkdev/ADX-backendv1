-- LH10 (the Lead Hunt, anti-gaming and quality): the clawback on a credited
-- incentive (a REVERSED status and the mirroring ledger transaction), the
-- proof a field visit carries for QA sampling, the integrity scan's flags on
-- a lead, and the sampled field work with its verdict.

-- CreateEnum
CREATE TYPE "LeadFlagKind" AS ENUM ('SELF_REFERRAL', 'PHONE_REUSE', 'CAPTURE_BURST', 'WEBHOOK_REPLAY');

-- CreateEnum
CREATE TYPE "LeadFlagStatus" AS ENUM ('OPEN', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "QaSampleKind" AS ENUM ('VISIT', 'CALL');

-- CreateEnum
CREATE TYPE "QaVerdict" AS ENUM ('PASS', 'FAIL');

-- AlterEnum
ALTER TYPE "IncentiveStatus" ADD VALUE 'REVERSED';


-- AlterTable
ALTER TABLE "AgentIncentive" ADD COLUMN     "reversalLedgerTransactionId" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "FieldVisit" ADD COLUMN     "proofAt" TIMESTAMP(3),
ADD COLUMN     "proofFileId" TEXT,
ADD COLUMN     "proofLatitude" DOUBLE PRECISION,
ADD COLUMN     "proofLongitude" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "LeadFlag" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "LeadFlagKind" NOT NULL,
    "status" "LeadFlagStatus" NOT NULL DEFAULT 'OPEN',
    "detail" TEXT NOT NULL,
    "evidence" JSONB,
    "agentId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "LeadFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadQaSample" (
    "id" TEXT NOT NULL,
    "kind" "QaSampleKind" NOT NULL,
    "agentId" TEXT NOT NULL,
    "visitId" TEXT,
    "messageId" TEXT,
    "leadId" TEXT,
    "evidence" JSONB NOT NULL,
    "autoVerdict" "QaVerdict" NOT NULL,
    "verdict" "QaVerdict",
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadQaSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadFlag_status_openedAt_idx" ON "LeadFlag"("status", "openedAt");

-- CreateIndex
CREATE INDEX "LeadFlag_agentId_status_idx" ON "LeadFlag"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeadFlag_leadId_kind_key" ON "LeadFlag"("leadId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LeadQaSample_visitId_key" ON "LeadQaSample"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadQaSample_messageId_key" ON "LeadQaSample"("messageId");

-- CreateIndex
CREATE INDEX "LeadQaSample_agentId_sampledAt_idx" ON "LeadQaSample"("agentId", "sampledAt");

-- CreateIndex
CREATE INDEX "LeadQaSample_kind_sampledAt_idx" ON "LeadQaSample"("kind", "sampledAt");

-- CreateIndex
CREATE INDEX "LeadQaSample_verdict_sampledAt_idx" ON "LeadQaSample"("verdict", "sampledAt");

-- AddForeignKey
ALTER TABLE "LeadFlag" ADD CONSTRAINT "LeadFlag_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadQaSample" ADD CONSTRAINT "LeadQaSample_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
