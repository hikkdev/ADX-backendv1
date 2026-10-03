-- HC-1 (1 Oct 2026): holidays from a public calendar.
--
-- The owner: "connect our holidays section to some free available holiday
-- calendar for every year so that we don't have to manually add everything
-- every time." Google's public "Holidays in India" iCal feed is read weekly;
-- each row now says where it came from. Additive only: every existing row
-- becomes MANUAL, not tentative and visible — exactly what it was before.
CREATE TYPE "HolidaySource" AS ENUM ('MANUAL', 'CALENDAR');

ALTER TABLE "Holiday" ADD COLUMN "source" "HolidaySource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Holiday" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Holiday" ADD COLUMN "tentative" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Holiday" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- One row per calendar event. Postgres keeps NULLs distinct, so the manual
-- rows (no externalId) never collide.
CREATE UNIQUE INDEX "Holiday_source_externalId_key" ON "Holiday"("source", "externalId");
