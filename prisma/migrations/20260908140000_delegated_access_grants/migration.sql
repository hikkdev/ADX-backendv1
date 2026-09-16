-- A publisher lending an agent limited access to their own account.
--
-- An agent may act for the publishers they onboarded and nobody else. This is
-- the sanctioned exception, and it is the publisher's to grant: they raise a
-- support ticket, ADX assigns an agent, and the publisher generates a QR from
-- their own app. Only the assigned agent can claim it, and the clock starts on
-- the scan rather than on generation.

-- CreateEnum
CREATE TYPE "AccessGrantScope" AS ENUM ('PROFILE', 'LISTINGS');

-- CreateEnum
CREATE TYPE "AccessGrantStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED');

-- AlterEnum
ALTER TYPE "QrType" ADD VALUE 'ACCESS_GRANT';

-- CreateTable
CREATE TABLE "DelegatedAccessGrant" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" "AccessGrantScope" NOT NULL,
    "listingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignedAgentId" TEXT NOT NULL,
    "supportTicketId" TEXT,
    "qrId" TEXT,
    "status" "AccessGrantStatus" NOT NULL DEFAULT 'PENDING',
    "durationMinutes" INTEGER NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegatedAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DelegatedAccessGrant_qrId_key" ON "DelegatedAccessGrant"("qrId");

-- The read on every guarded write: does this agent hold a live grant here.
-- CreateIndex
CREATE INDEX "DelegatedAccessGrant_assignedAgentId_status_expiresAt_idx" ON "DelegatedAccessGrant"("assignedAgentId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "DelegatedAccessGrant_publisherId_status_idx" ON "DelegatedAccessGrant"("publisherId", "status");

-- AddForeignKey
ALTER TABLE "DelegatedAccessGrant" ADD CONSTRAINT "DelegatedAccessGrant_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedAccessGrant" ADD CONSTRAINT "DelegatedAccessGrant_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegatedAccessGrant" ADD CONSTRAINT "DelegatedAccessGrant_supportTicketId_fkey" FOREIGN KEY ("supportTicketId") REFERENCES "SupportTicket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
