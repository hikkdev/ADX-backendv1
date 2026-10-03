-- AB-1 (25 Sep 2026): per-spot print choice, ADX design quotes, booking ids, self-install notes, billing PIN/country.
-- AlterEnum
ALTER TYPE "PartyType" ADD VALUE 'ORDER';

-- AlterTable
ALTER TABLE "CampaignSpot" ADD COLUMN "fulfilment" "FulfilmentChoice";

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "designQuoteAmount" DECIMAL(14,2),
ADD COLUMN "designQuoteStatus" TEXT,
ADD COLUMN "designQuoteNote" TEXT,
ADD COLUMN "designQuotedAt" TIMESTAMP(3),
ADD COLUMN "designQuotedByUserId" TEXT,
ADD COLUMN "designQuoteRespondedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "displayId" TEXT,
ADD COLUMN "selfInstallNotes" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_displayId_key" ON "Order"("displayId");

-- AlterTable
ALTER TABLE "Advertiser" ADD COLUMN "postalCode" TEXT,
ADD COLUMN "country" TEXT;
