-- GC-1 (23 Sep 2026): the GPS camera stamp.
--
-- A photo uploaded with the phone's fix beside it is stored with a stamp
-- burned into the pixels and the EXIF GPS block written; these columns keep
-- the same facts on the row so they can be read without opening the file.
-- Null on every file that did not ask for a stamp.
--
-- The four DROP INDEX lines the diff emits are pre-existing drift between the
-- database and the schema file and are deliberately not applied here.

ALTER TABLE "UploadedFile"
  ADD COLUMN "latitude"   DOUBLE PRECISION,
  ADD COLUMN "longitude"  DOUBLE PRECISION,
  ADD COLUMN "accuracyM"  DOUBLE PRECISION,
  ADD COLUMN "takenAt"    TIMESTAMP(3),
  ADD COLUMN "geoStamped" BOOLEAN NOT NULL DEFAULT false;
