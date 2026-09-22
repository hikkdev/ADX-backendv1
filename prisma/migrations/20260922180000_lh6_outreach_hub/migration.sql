-- LH6 (the Lead Hunt, 22 Sep 2026): the outreach hub — conversations and
-- messages per channel, calls as messages, sequences and their runs;
-- WhatsApp joins the notification channels. Diffed from the schema.

-- CreateEnum
CREATE TYPE "LeadChannel" AS ENUM ('SMS', 'EMAIL', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'GOOGLE_BUSINESS', 'CALL', 'LINKEDIN', 'IN_PERSON', 'OTHER');

-- CreateEnum
CREATE TYPE "LeadMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "LeadMessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "LeadCallOutcome" AS ENUM ('ANSWERED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL');

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'WHATSAPP';

-- CreateTable
CREATE TABLE "LeadConversation" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "channel" "LeadChannel" NOT NULL,
    "providerThreadId" TEXT,
    "windowClosesAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "direction" "LeadMessageDirection" NOT NULL,
    "channel" "LeadChannel" NOT NULL,
    "templateKey" TEXT,
    "body" TEXT NOT NULL,
    "providerId" TEXT,
    "status" "LeadMessageStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "sequenceRunId" TEXT,
    "maskedNumber" TEXT,
    "providerCallId" TEXT,
    "outcome" "LeadCallOutcome",
    "durationSec" INTEGER,
    "consentPlayed" BOOLEAN,
    "recordingFileId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byAgentId" TEXT,
    "byUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSequence" (
    "id" TEXT NOT NULL,
    "side" "LeadSide" NOT NULL,
    "temperature" "LeadTemperature" NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSequenceRun" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,

    CONSTRAINT "LeadSequenceRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadConversation_channel_providerThreadId_idx" ON "LeadConversation"("channel", "providerThreadId");

-- CreateIndex
CREATE INDEX "LeadConversation_lastInboundAt_idx" ON "LeadConversation"("lastInboundAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadConversation_leadId_channel_key" ON "LeadConversation"("leadId", "channel");

-- CreateIndex
CREATE INDEX "LeadMessage_leadId_at_idx" ON "LeadMessage"("leadId", "at");

-- CreateIndex
CREATE INDEX "LeadMessage_conversationId_at_idx" ON "LeadMessage"("conversationId", "at");

-- CreateIndex
CREATE INDEX "LeadMessage_status_scheduledFor_idx" ON "LeadMessage"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "LeadMessage_direction_channel_at_idx" ON "LeadMessage"("direction", "channel", "at");

-- CreateIndex
CREATE INDEX "LeadMessage_recordingFileId_idx" ON "LeadMessage"("recordingFileId");

-- CreateIndex
CREATE INDEX "LeadMessage_providerCallId_idx" ON "LeadMessage"("providerCallId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadMessage_channel_providerId_key" ON "LeadMessage"("channel", "providerId");

-- CreateIndex
CREATE INDEX "LeadSequence_side_temperature_isActive_idx" ON "LeadSequence"("side", "temperature", "isActive");

-- CreateIndex
CREATE INDEX "LeadSequenceRun_leadId_stoppedAt_idx" ON "LeadSequenceRun"("leadId", "stoppedAt");

-- CreateIndex
CREATE INDEX "LeadSequenceRun_stoppedAt_nextAt_idx" ON "LeadSequenceRun"("stoppedAt", "nextAt");

-- CreateIndex
CREATE INDEX "LeadSequenceRun_sequenceId_idx" ON "LeadSequenceRun"("sequenceId");

-- AddForeignKey
ALTER TABLE "LeadConversation" ADD CONSTRAINT "LeadConversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadMessage" ADD CONSTRAINT "LeadMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "LeadConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadMessage" ADD CONSTRAINT "LeadMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSequenceRun" ADD CONSTRAINT "LeadSequenceRun_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSequenceRun" ADD CONSTRAINT "LeadSequenceRun_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "LeadSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
