-- D5: a real agent status, the territory, and DR 07's work preferences on the profile.
CREATE TYPE "AgentProfileStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'SUSPENDED');

ALTER TABLE "AgentProfile"
  ADD COLUMN "status" "AgentProfileStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "territory" TEXT,
  ADD COLUMN "homeZone" TEXT,
  ADD COLUMN "radiusKm" INTEGER,
  ADD COLUMN "workingDays" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "hoursFrom" TEXT,
  ADD COLUMN "hoursTo" TEXT,
  ADD COLUMN "autoAcceptInZone" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "orderTypes" "ListingCategory"[] DEFAULT ARRAY[]::"ListingCategory"[],
  ADD COLUMN "maxActiveOrders" INTEGER,
  ADD COLUMN "businessName" TEXT;

CREATE INDEX "AgentProfile_status_idx" ON "AgentProfile"("status");
