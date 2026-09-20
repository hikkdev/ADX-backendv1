-- QR-14 (17 Sep 2026): who onboarded whom — the door, the person, their role at the time, and when.
CREATE TYPE "OnboardingSource" AS ENUM ('SELF', 'AGENT', 'QR', 'DESK', 'IMPORT');

ALTER TABLE "Publisher"
  ADD COLUMN "onboardedVia" "OnboardingSource",
  ADD COLUMN "onboardedById" TEXT,
  ADD COLUMN "onboardedByRole" TEXT,
  ADD COLUMN "onboardedAt" TIMESTAMP(3);
CREATE INDEX "Publisher_onboardedById_idx" ON "Publisher"("onboardedById");
CREATE INDEX "Publisher_onboardedVia_idx" ON "Publisher"("onboardedVia");

ALTER TABLE "Advertiser"
  ADD COLUMN "onboardedVia" "OnboardingSource",
  ADD COLUMN "onboardedById" TEXT,
  ADD COLUMN "onboardedByRole" TEXT,
  ADD COLUMN "onboardedAt" TIMESTAMP(3);
CREATE INDEX "Advertiser_onboardedById_idx" ON "Advertiser"("onboardedById");
CREATE INDEX "Advertiser_onboardedVia_idx" ON "Advertiser"("onboardedVia");

-- Backfill, most specific door first; a row already stamped is left alone.

-- Publishers created by an import: the batch's uploader.
UPDATE "Publisher" p
SET "onboardedVia" = 'IMPORT', "onboardedById" = i."uploadedById", "onboardedByRole" = 'Admin', "onboardedAt" = COALESCE(i."committedAt", p."createdAt")
FROM "PublisherImportRow" r JOIN "PublisherImport" i ON i."id" = r."importId"
WHERE r."publisherId" = p."id" AND r."outcome" = 'CREATED' AND p."onboardedVia" IS NULL;

-- Publishers opened at the desk: the audit row names the admin.
UPDATE "Publisher" p
SET "onboardedVia" = 'DESK', "onboardedById" = a."userId", "onboardedByRole" = 'Admin', "onboardedAt" = a."createdAt"
FROM "ActivityLog" a
WHERE a."action" = 'PUBLISHER_CREATED_BY_ADMIN' AND a."targetId" = p."id" AND p."onboardedVia" IS NULL;

-- Publishers an agent scanned in, or opened at the door.
UPDATE "Publisher" p
SET "onboardedVia" = CASE WHEN p."claimedAt" IS NOT NULL THEN 'QR'::"OnboardingSource" ELSE 'AGENT'::"OnboardingSource" END,
    "onboardedById" = g."userId", "onboardedByRole" = 'Agent', "onboardedAt" = COALESCE(p."claimedAt", p."createdAt")
FROM "AgentProfile" g
WHERE g."id" = p."agentId" AND p."onboardedVia" IS NULL;

-- Everyone else with an account signed themselves up.
UPDATE "Publisher" SET "onboardedVia" = 'SELF', "onboardedAt" = "createdAt" WHERE "onboardedVia" IS NULL AND "userId" IS NOT NULL;

-- Advertisers created by an import.
UPDATE "Advertiser" ad
SET "onboardedVia" = 'IMPORT', "onboardedById" = i."uploadedById", "onboardedByRole" = 'Admin', "onboardedAt" = COALESCE(i."committedAt", ad."createdAt")
FROM "PartyImportRow" r JOIN "PartyImport" i ON i."id" = r."importId"
WHERE r."targetId" = ad."id" AND i."party" = 'ADVERTISER' AND r."outcome" = 'CREATED' AND ad."onboardedVia" IS NULL;

-- Advertisers an agent opened at the door.
UPDATE "Advertiser" ad
SET "onboardedVia" = 'AGENT', "onboardedById" = g."userId", "onboardedByRole" = 'Agent', "onboardedAt" = ad."createdAt"
FROM "AgentProfile" g
WHERE g."id" = ad."agentId" AND ad."onboardedVia" IS NULL;

-- Advertisers with an account signed themselves up; the rest were opened at the desk by someone the trail did not name.
UPDATE "Advertiser" SET "onboardedVia" = 'SELF', "onboardedAt" = "createdAt" WHERE "onboardedVia" IS NULL AND "userId" IS NOT NULL;
UPDATE "Advertiser" SET "onboardedVia" = 'DESK', "onboardedByRole" = 'Admin', "onboardedAt" = "createdAt" WHERE "onboardedVia" IS NULL;
