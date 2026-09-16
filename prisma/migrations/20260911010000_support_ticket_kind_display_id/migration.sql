-- DR 07 wave 2: tickets get a kind (issue or feedback), a human number minted
-- through the identifiers counter, and the files attached when they were raised.

-- AlterEnum: two more series for the identifiers counter. Not parties, but the
-- same guarantee — issued once, never derived.
ALTER TYPE "PartyType" ADD VALUE 'TICKET';
ALTER TYPE "PartyType" ADD VALUE 'FEEDBACK';

-- CreateEnum
CREATE TYPE "TicketKind" AS ENUM ('ISSUE', 'FEEDBACK');

-- AlterTable
ALTER TABLE "SupportTicket"
  ADD COLUMN "kind" "TicketKind" NOT NULL DEFAULT 'ISSUE',
  ADD COLUMN "displayId" TEXT,
  ADD COLUMN "attachmentUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_displayId_key" ON "SupportTicket"("displayId");
