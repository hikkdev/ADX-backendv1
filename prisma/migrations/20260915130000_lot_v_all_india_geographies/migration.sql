-- Lot V: all of India as the geography; a rollout stage and per-function switches on every city.
CREATE TYPE "CityStage" AS ENUM ('PLANNED', 'SEEDING', 'LAUNCHED', 'PAUSED', 'WITHDRAWN');

CREATE TABLE "GeoState" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "geonameId" INTEGER,
  CONSTRAINT "GeoState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GeoState_code_key" ON "GeoState"("code");
CREATE UNIQUE INDEX "GeoState_geonameId_key" ON "GeoState"("geonameId");

CREATE TABLE "GeoDistrict" (
  "id" TEXT NOT NULL,
  "stateId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "geonameId" INTEGER,
  CONSTRAINT "GeoDistrict_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GeoDistrict_geonameId_key" ON "GeoDistrict"("geonameId");
CREATE UNIQUE INDEX "GeoDistrict_stateId_code_key" ON "GeoDistrict"("stateId", "code");
CREATE INDEX "GeoDistrict_stateId_name_idx" ON "GeoDistrict"("stateId", "name");
ALTER TABLE "GeoDistrict" ADD CONSTRAINT "GeoDistrict_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "GeoState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "City" ADD COLUMN "stateId" TEXT;
ALTER TABLE "City" ADD COLUMN "districtId" TEXT;
ALTER TABLE "City" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "City" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "City" ADD COLUMN "population" INTEGER;
ALTER TABLE "City" ADD COLUMN "kind" TEXT;
ALTER TABLE "City" ADD COLUMN "geonameId" INTEGER;
ALTER TABLE "City" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'SEED';
ALTER TABLE "City" ADD COLUMN "stage" "CityStage" NOT NULL DEFAULT 'PLANNED';
ALTER TABLE "City" ADD COLUMN "supplyIntake" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "publishing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "demand" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "agentOnboarding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "printPartners" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "leadFeeds" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "City" ADD COLUMN "launchedAt" TIMESTAMP(3);
ALTER TABLE "City" ADD COLUMN "pausedAt" TIMESTAMP(3);
ALTER TABLE "City" ADD COLUMN "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "City" ADD COLUMN "rolloutNote" TEXT;
CREATE UNIQUE INDEX "City_geonameId_key" ON "City"("geonameId");
CREATE INDEX "City_stage_idx" ON "City"("stage");
CREATE INDEX "City_stateId_stage_idx" ON "City"("stateId", "stage");
CREATE INDEX "City_districtId_idx" ON "City"("districtId");
ALTER TABLE "City" ADD CONSTRAINT "City_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "GeoState"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "City" ADD CONSTRAINT "City_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "GeoDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The forty-six seeded cities keep the standing they had: open = LAUNCHED with everything on, closed = WITHDRAWN.
UPDATE "City" SET "stage" = 'LAUNCHED', "supplyIntake" = true, "publishing" = true, "demand" = true, "agentOnboarding" = true, "printPartners" = true, "leadFeeds" = true, "launchedAt" = "createdAt" WHERE "isActive" = true;
UPDATE "City" SET "stage" = 'WITHDRAWN', "withdrawnAt" = "updatedAt" WHERE "isActive" = false;

CREATE TABLE "CityRolloutEvent" (
  "id" TEXT NOT NULL,
  "cityId" TEXT NOT NULL,
  "fromStage" "CityStage" NOT NULL,
  "toStage" "CityStage" NOT NULL,
  "flags" JSONB NOT NULL,
  "byUserId" TEXT NOT NULL,
  "note" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CityRolloutEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CityRolloutEvent_cityId_at_idx" ON "CityRolloutEvent"("cityId", "at");
ALTER TABLE "CityRolloutEvent" ADD CONSTRAINT "CityRolloutEvent_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
