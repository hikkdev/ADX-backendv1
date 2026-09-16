-- Human-readable party identifiers: PUB-1909-2601 and friends.
--
-- Publisher.displayId is nullable so existing rows survive the migration;
-- they are backfilled separately, in join order, so the sequence a
-- publisher would have received on their signup day is what they get.

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('PUBLISHER', 'ADVERTISER', 'PARTNER', 'EMPLOYEE', 'AGENT');

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "displayId" TEXT;

-- CreateTable
CREATE TABLE "IdentifierFormat" (
    "id" TEXT NOT NULL,
    "party" "PartyType" NOT NULL,
    "prefix" TEXT NOT NULL,
    "pattern" TEXT NOT NULL DEFAULT '{PREFIX}-{DD}{MM}-{YY}{SEQ}',
    "seqPadding" INTEGER NOT NULL DEFAULT 2,
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentifierFormat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentifierCounter" (
    "id" TEXT NOT NULL,
    "party" "PartyType" NOT NULL,
    "dateKey" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "IdentifierCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IdentifierFormat_party_key" ON "IdentifierFormat"("party");

-- CreateIndex
CREATE UNIQUE INDEX "IdentifierCounter_party_dateKey_key" ON "IdentifierCounter"("party", "dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "Publisher_displayId_key" ON "Publisher"("displayId");

