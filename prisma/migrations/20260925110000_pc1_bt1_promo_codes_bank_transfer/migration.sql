-- PC-1 + BT-1 (25 Sep 2026): promo codes on a booking, and bank transfer as a way to pay.
-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE 'BANK_TRANSFER';

-- CreateEnum
CREATE TYPE "PromoDiscountKind" AS ENUM ('PERCENT', 'FLAT');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "bankUtr" TEXT,
ADD COLUMN "bankPaidOn" DATE,
ADD COLUMN "bankClaimedAmount" DECIMAL(14,2),
ADD COLUMN "bankProofFileId" TEXT,
ADD COLUMN "bankClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "promoCodeId" TEXT;

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PromoDiscountKind" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "maxDiscount" DECIMAL(14,2),
    "minSpend" DECIMAL(14,2),
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "perAdvertiserLimit" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_isActive_endsAt_idx" ON "PromoCode"("isActive", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_campaignId_key" ON "PromoRedemption"("campaignId");

-- CreateIndex
CREATE INDEX "PromoRedemption_promoCodeId_advertiserId_releasedAt_idx" ON "PromoRedemption"("promoCodeId", "advertiserId", "releasedAt");

-- CreateIndex
CREATE INDEX "Campaign_promoCodeId_idx" ON "Campaign"("promoCodeId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
