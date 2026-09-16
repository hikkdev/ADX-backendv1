-- Lot D (Q57/Q94): the legacy creative library had five role-less routes and
-- no consumer anywhere; the campaign creative is the record. The column on
-- Order that nothing read goes with it.
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_advertisementId_fkey";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "advertisementId";
DROP TABLE IF EXISTS "Advertisement";
DROP TYPE IF EXISTS "AdvertisementStatus";
