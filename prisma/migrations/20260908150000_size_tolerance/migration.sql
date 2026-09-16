-- How far a measurement may sit from an existing size class and still be filed
-- as that class.
--
-- A size class is a comparable pool. The listing flow measures rather than
-- picks, and no two tapes agree to the centimetre, so exact matching minted a
-- class per measurement: two spots any buyer would call identical were never
-- compared. The industry builds to standard sizes, so 20 x 10.5 is a 20 x 10.
-- AlterTable
ALTER TABLE "PricingSettings" ADD COLUMN "sizeTolerancePct" DECIMAL(5,4) NOT NULL DEFAULT 0.03;
