-- CreateEnum
CREATE TYPE "AdvertiserType" AS ENUM ('INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY');

-- CreateEnum
CREATE TYPE "BrandSector" AS ENUM ('GENERAL', 'ALCOHOL', 'TOBACCO', 'GAMBLING', 'PHARMA', 'POLITICAL', 'FINANCIAL', 'REAL_ESTATE', 'EDUCATION', 'HEALTHCARE', 'INFANT_NUTRITION');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('TOPUP', 'CAMPAIGN_DEBIT', 'GOODWILL_CREDIT', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WalletHoldStatus" AS ENUM ('HELD', 'CAPTURED', 'RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgreementKind" ADD VALUE 'ADVERTISER_PLATFORM';
ALTER TYPE "AgreementKind" ADD VALUE 'INSERTION_ORDER';

-- DropForeignKey
ALTER TABLE "AgreementAcceptance" DROP CONSTRAINT "AgreementAcceptance_publisherId_fkey";

-- AlterTable
ALTER TABLE "AgreementAcceptance" ADD COLUMN     "advertiserId" TEXT,
ADD COLUMN     "campaignId" TEXT,
ALTER COLUMN "publisherId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Advertiser" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "agentId" TEXT,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT,
    "type" "AdvertiserType" NOT NULL DEFAULT 'INDIVIDUAL',
    "companyName" TEXT,
    "gstin" TEXT,
    "billingAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "displayId" TEXT,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "creditLimit" DECIMAL(14,2),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Advertiser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sector" "BrandSector" NOT NULL DEFAULT 'GENERAL',
    "logoUrl" TEXT,
    "website" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "goodwill" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "isGoodwill" BOOLEAN NOT NULL DEFAULT false,
    "campaignId" TEXT,
    "holdId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletHold" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "WalletHoldStatus" NOT NULL DEFAULT 'HELD',
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "WalletHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_userId_key" ON "Advertiser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_mobile_key" ON "Advertiser"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_displayId_key" ON "Advertiser"("displayId");

-- CreateIndex
CREATE INDEX "Advertiser_agentId_idx" ON "Advertiser"("agentId");

-- CreateIndex
CREATE INDEX "Advertiser_mobile_idx" ON "Advertiser"("mobile");

-- CreateIndex
CREATE INDEX "Advertiser_kycStatus_createdAt_idx" ON "Advertiser"("kycStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Brand_advertiserId_idx" ON "Brand"("advertiserId");

-- CreateIndex
CREATE INDEX "Brand_sector_idx" ON "Brand"("sector");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_advertiserId_name_key" ON "Brand"("advertiserId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_advertiserId_key" ON "Wallet"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletEntry_holdId_key" ON "WalletEntry"("holdId");

-- CreateIndex
CREATE INDEX "WalletEntry_walletId_createdAt_idx" ON "WalletEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletEntry_campaignId_idx" ON "WalletEntry"("campaignId");

-- CreateIndex
CREATE INDEX "WalletHold_walletId_status_idx" ON "WalletHold"("walletId", "status");

-- CreateIndex
CREATE INDEX "WalletHold_campaignId_idx" ON "WalletHold"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementAcceptance_campaignId_key" ON "AgreementAcceptance"("campaignId");

-- CreateIndex
CREATE INDEX "AgreementAcceptance_advertiserId_templateKind_idx" ON "AgreementAcceptance"("advertiserId", "templateKind");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementAcceptance_advertiserId_templateId_key" ON "AgreementAcceptance"("advertiserId", "templateId");

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advertiser" ADD CONSTRAINT "Advertiser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advertiser" ADD CONSTRAINT "Advertiser_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
