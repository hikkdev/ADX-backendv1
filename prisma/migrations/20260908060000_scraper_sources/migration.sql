-- CreateEnum
CREATE TYPE "ScraperSourceKind" AS ENUM ('HTML', 'FEED', 'JSON', 'MANUAL');

-- CreateEnum
CREATE TYPE "ScraperRunStatus" AS ENUM ('OK', 'NO_MATCHES', 'FETCH_FAILED', 'PARSE_FAILED');

-- AlterTable
ALTER TABLE "SurgeEvent" ADD COLUMN     "scraperSourceId" TEXT;

-- CreateTable
CREATE TABLE "ScraperSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "ScraperSourceKind" NOT NULL DEFAULT 'HTML',
    "citySlugs" TEXT[],
    "fieldMap" JSONB,
    "defaultUpliftPct" DECIMAL(5,4) NOT NULL DEFAULT 0.10,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "autoEnableWindows" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledById" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disabledNote" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" "ScraperRunStatus",
    "lastRunMessage" TEXT,
    "lastRunFound" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScraperSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperRun" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" "ScraperRunStatus" NOT NULL,
    "message" TEXT,
    "found" INTEGER NOT NULL DEFAULT 0,
    "windowsUpserted" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScraperRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScraperSource_isEnabled_lastRunAt_idx" ON "ScraperSource"("isEnabled", "lastRunAt");

-- CreateIndex
CREATE INDEX "ScraperRun_sourceId_startedAt_idx" ON "ScraperRun"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "ScraperRun" ADD CONSTRAINT "ScraperRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ScraperSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
