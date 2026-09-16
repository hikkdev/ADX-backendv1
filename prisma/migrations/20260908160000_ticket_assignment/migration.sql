-- The agent ADX puts on a support request.
--
-- Delegated access flows from here. A publisher asking for help should never
-- have to know an agent's id: they raise a ticket, ADX decides who handles it,
-- and the access code they generate is bound to whoever that was. Asking the
-- publisher to type it made the assignment something they could get wrong, or
-- be talked into getting wrong.
-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN "assignedAgentId" TEXT,
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedById" TEXT;

-- The ops queue: open tickets, with the unassigned ones findable.
-- CreateIndex
CREATE INDEX "SupportTicket_status_assignedAgentId_idx" ON "SupportTicket"("status", "assignedAgentId");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
