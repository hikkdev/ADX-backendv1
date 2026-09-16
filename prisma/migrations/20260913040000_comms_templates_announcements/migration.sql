-- Lot E (Q46/Q62/Q64): outbound templates, a masked delivery log with a
-- retention window, and broadcasts. In-app copy stays in code.
ALTER TYPE "NotificationType" ADD VALUE 'ANNOUNCEMENT';
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED');
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'PUBLISHERS', 'ADVERTISERS', 'AGENTS');
CREATE TYPE "AnnouncementImportance" AS ENUM ('NORMAL', 'CRITICAL');
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

CREATE TABLE "NotificationTemplate" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "channels" "NotificationChannel"[] NOT NULL DEFAULT ARRAY[]::"NotificationChannel"[],
  "subject" TEXT,
  "emailBody" TEXT,
  "smsKind" TEXT,
  "smsBody" TEXT,
  "isSensitive" BOOLEAN NOT NULL DEFAULT false,
  "status" "TemplateStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationTemplate_key_key" ON "NotificationTemplate"("key");
CREATE INDEX "NotificationTemplate_event_status_idx" ON "NotificationTemplate"("event", "status");

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "notificationId" TEXT,
  "templateKey" TEXT,
  "channel" "NotificationChannel" NOT NULL,
  "recipientMasked" TEXT NOT NULL,
  "recipientHash" TEXT NOT NULL,
  "variables" JSONB,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_recipientHash_createdAt_idx" ON "NotificationDelivery"("recipientHash", "createdAt");
CREATE INDEX "NotificationDelivery_providerMessageId_idx" ON "NotificationDelivery"("providerMessageId");
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");

CREATE TABLE "Announcement" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
  "city" TEXT,
  "channels" "NotificationChannel"[] NOT NULL DEFAULT ARRAY[]::"NotificationChannel"[],
  "importance" "AnnouncementImportance" NOT NULL DEFAULT 'NORMAL',
  "scheduledAt" TIMESTAMP(3),
  "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "deliveredByChannel" JSONB,
  "createdById" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Announcement_status_scheduledAt_idx" ON "Announcement"("status", "scheduledAt");

CREATE TABLE "AnnouncementDelivery" (
  "id" TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnouncementDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnnouncementDelivery_announcementId_userId_channel_key" ON "AnnouncementDelivery"("announcementId", "userId", "channel");
ALTER TABLE "AnnouncementDelivery" ADD CONSTRAINT "AnnouncementDelivery_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "emailUnsubscribedAt" TIMESTAMP(3);
