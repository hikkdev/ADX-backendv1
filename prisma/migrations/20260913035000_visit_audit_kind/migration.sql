-- Lot E (Q99): audits and poster checks are visits, paid at the visit rate;
-- a drive is a tag over the visits it spawned.
ALTER TYPE "FieldVisitKind" ADD VALUE 'AUDIT';
ALTER TABLE "FieldVisit" ADD COLUMN "campaignTag" TEXT;
