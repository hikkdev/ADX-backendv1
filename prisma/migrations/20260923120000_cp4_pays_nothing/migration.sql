-- CP-4 (23 Sep 2026): a rate key may pay nothing, deliberately.
--
-- Lead rewards are an advertiser-side idea: the owner pays them because an
-- advertiser agent brings revenue. Switching the publisher side off needs a
-- ROW, because the resolution order (TIER:SIDE -> TIER -> *:SIDE -> *) only
-- lets a narrower row beat a broader one — and a row of 0.00 would be
-- indistinguishable from a price nobody has set yet. This flag is the
-- difference between "free" and "off".
--
-- The four DROP INDEX lines the diff emits are pre-existing drift between the
-- database and the schema file and are deliberately not applied here.

-- AlterTable
ALTER TABLE "IncentiveRate" ADD COLUMN     "paysNothing" BOOLEAN NOT NULL DEFAULT false;
