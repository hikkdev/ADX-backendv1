-- Lot E (Q69/Q72/Q98/Q99): the one HR record kept in-house and the staff
-- diary ADX owns; field work is overlaid from its own tables, never copied.
CREATE TYPE "ScheduleEntryStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PAUSED', 'COMPLETED');

CREATE TABLE "Holiday" (
  "id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "region" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Holiday_date_region_key" ON "Holiday"("date", "region");

CREATE TABLE "ScheduleEntry" (
  "id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "assigneeUserId" TEXT NOT NULL,
  "department" TEXT,
  "status" "ScheduleEntryStatus" NOT NULL DEFAULT 'PENDING',
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduleEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduleEntry_date_assigneeUserId_idx" ON "ScheduleEntry"("date", "assigneeUserId");
CREATE INDEX "ScheduleEntry_assigneeUserId_date_idx" ON "ScheduleEntry"("assigneeUserId", "date");
