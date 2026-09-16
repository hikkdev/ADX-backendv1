-- D4: an agent's own identity record. Agents are onboarded at ADX's desk, so
-- the documents are recorded on their behalf by the admin who met them; the
-- review is the same PENDING / VERIFIED / REJECTED decision every other KYC
-- row gets. One row per agent, cascading with the profile.

-- CreateTable
CREATE TABLE "AgentKyc" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "govIdType" TEXT,
    "govIdFrontUrl" TEXT,
    "govIdBackUrl" TEXT,
    "panNumber" TEXT,
    "panFrontUrl" TEXT,
    "panSignatureUrl" TEXT,
    "addressProofType" TEXT,
    "addressProofUrl" TEXT,
    "selfieUrl" TEXT,
    "bankProofUrl" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "recordedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentKyc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentKyc_agentId_key" ON "AgentKyc"("agentId");
CREATE INDEX "AgentKyc_status_submittedAt_idx" ON "AgentKyc"("status", "submittedAt");

-- AddForeignKey
ALTER TABLE "AgentKyc"
  ADD CONSTRAINT "AgentKyc_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
