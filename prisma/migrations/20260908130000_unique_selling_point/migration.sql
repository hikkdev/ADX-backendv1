-- DR 02 step 5 asks for the "unique selling point" -- an argument the publisher
-- is making. `visibility` is the observable property a pricing factor reads.
-- Two different things, and one name for both is how they end up conflated.
-- AlterTable
ALTER TABLE "Listing" RENAME COLUMN "visibilityNote" TO "uniqueSellingPoint";
