-- Lot G addendum: what the packages asked for once they had built.
ALTER TABLE "NotificationDelivery" ADD COLUMN "scheduledFor" TIMESTAMP(3);
CREATE INDEX "NotificationDelivery_status_scheduledFor_idx" ON "NotificationDelivery"("status", "scheduledFor");
ALTER TABLE "NotificationTemplate" ADD COLUMN "pushTitle" TEXT;
ALTER TABLE "NotificationTemplate" ADD COLUMN "pushBody" TEXT;
