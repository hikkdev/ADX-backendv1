-- LH7 (the Lead Hunt, 22 Sep 2026): invite links (D6) and the proposals sent —
-- the landing behind adx.in/j/<code>. Diffed from the schema.

-- CreateEnum
CREATE TYPE "LeadProposalKind" AS ENUM ('RATE_ESTIMATE', 'CAMPAIGN_ESTIMATE', 'PACKAGE_QUOTE');

-- CreateTable
CREATE TABLE "LeadInvite" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "opens" JSONB NOT NULL DEFAULT '[]',
    "convertedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "issuedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadProposal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "LeadProposalKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "note" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadInvite_code_key" ON "LeadInvite"("code");

-- CreateIndex
CREATE INDEX "LeadInvite_leadId_createdAt_idx" ON "LeadInvite"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadInvite_expiresAt_idx" ON "LeadInvite"("expiresAt");

-- CreateIndex
CREATE INDEX "LeadProposal_leadId_sentAt_idx" ON "LeadProposal"("leadId", "sentAt");

-- AddForeignKey
ALTER TABLE "LeadInvite" ADD CONSTRAINT "LeadInvite_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadProposal" ADD CONSTRAINT "LeadProposal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
