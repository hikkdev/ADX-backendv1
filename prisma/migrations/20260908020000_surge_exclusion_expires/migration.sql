-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "ratePerDaySetDuringSurge",
ADD COLUMN     "ratePerDaySurgeUntil" TIMESTAMP(3);
