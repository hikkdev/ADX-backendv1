-- QR-4 (17 Sep 2026): the person's own ADX id and their two names.
--
-- Additive. `displayId` is minted at first sign-in from now on (the USER
-- series, prefix ADX); rows that predate it are filled by the identifiers
-- backfill against their own createdAt. `firstName` / `lastName` are asked
-- right after the first OTP; `name` stays the display name.
ALTER TYPE "PartyType" ADD VALUE 'USER';

ALTER TABLE "User" ADD COLUMN "displayId" TEXT;
ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

CREATE UNIQUE INDEX "User_displayId_key" ON "User"("displayId");
