-- QR-5 (17 Sep 2026): the details a publisher gives before their first
-- listing, and the pin behind their address.
--
-- Additive. `dateOfBirth` joins name, email and address as the basics the
-- listing door checks; `gender` is asked and never required; the publisher's
-- `latitude` / `longitude` are set when the address came off the map or a
-- search and stay null when it was typed.
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

ALTER TABLE "User" ADD COLUMN "dateOfBirth" DATE;
ALTER TABLE "User" ADD COLUMN "gender" "Gender";

ALTER TABLE "Publisher" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Publisher" ADD COLUMN "longitude" DOUBLE PRECISION;
