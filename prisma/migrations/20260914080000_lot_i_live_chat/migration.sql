-- Lot I: live chat for paid subscribers.
CREATE TYPE "TicketChannel" AS ENUM ('TICKET', 'LIVE_CHAT');
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'ATTACHMENT', 'SYSTEM');
ALTER TABLE "SupportTicket" ADD COLUMN "channel" "TicketChannel" NOT NULL DEFAULT 'TICKET';
ALTER TABLE "SupportTicket" ADD COLUMN "requesterSeenAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN "agentSeenAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN "firstResponseAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN "lastMessageAt" TIMESTAMP(3);
CREATE INDEX "SupportTicket_channel_status_lastMessageAt_idx" ON "SupportTicket"("channel", "status", "lastMessageAt");
ALTER TABLE "TicketMessage" ADD COLUMN "kind" "MessageKind" NOT NULL DEFAULT 'TEXT';
ALTER TABLE "TicketMessage" ADD COLUMN "attachmentFileId" TEXT;
ALTER TABLE "TicketMessage" ADD COLUMN "attachmentName" TEXT;
ALTER TABLE "TicketMessage" ADD COLUMN "seenAt" TIMESTAMP(3);
CREATE TABLE "CannedReply" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "team" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CannedReply_team_isActive_idx" ON "CannedReply"("team", "isActive");
