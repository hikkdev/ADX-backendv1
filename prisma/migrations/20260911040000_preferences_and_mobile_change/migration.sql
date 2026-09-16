-- DR 07 wave 5: the notification channel axis, per-person preferences, and the
-- OTP purpose that proves a new number before the identity moves to it.
ALTER TYPE "OtpPurpose" ADD VALUE 'CHANGE_MOBILE';

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS');

-- Every row written before this migration is the in-app list, which is the one
-- channel that has ever been delivered.
ALTER TABLE "NotificationPreference" ADD COLUMN "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP';
DROP INDEX IF EXISTS "NotificationPreference_userId_type_key";
CREATE UNIQUE INDEX "NotificationPreference_userId_type_channel_key" ON "NotificationPreference"("userId", "type", "channel");

CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPreference_userId_key_key" ON "UserPreference"("userId", "key");
CREATE INDEX "UserPreference_userId_idx" ON "UserPreference"("userId");

ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
