-- CreateEnum
CREATE TYPE "PackageTier" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "PackageBillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PackageSaleStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PackagePaymentMethod" AS ENUM ('WALLET', 'OFFLINE');

-- CreateTable
CREATE TABLE "AdvertiserPackage" (
    "id" TEXT NOT NULL,
    "tier" "PackageTier" NOT NULL,
    "name" TEXT NOT NULL,
    "pricePerMonth" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "entitlements" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageAddOn" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricePerMonth" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageSale" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "agentId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "tier" "PackageTier" NOT NULL,
    "packageName" TEXT NOT NULL,
    "pricePerMonth" DECIMAL(14,2) NOT NULL,
    "cycle" "PackageBillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "months" INTEGER NOT NULL DEFAULT 1,
    "addOnsPerMonth" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstPct" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "PackageSaleStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentToken" TEXT NOT NULL,
    "paymentLinkSentAt" TIMESTAMP(3),
    "paymentLinkSends" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "paidMethod" "PackagePaymentMethod",
    "paidReference" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "nextBillingAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageSaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pricePerMonth" DECIMAL(14,2) NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PackageSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserPackage_tier_key" ON "AdvertiserPackage"("tier");

-- CreateIndex
CREATE INDEX "AdvertiserPackage_isActive_sortOrder_idx" ON "AdvertiserPackage"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PackageAddOn_code_key" ON "PackageAddOn"("code");

-- CreateIndex
CREATE INDEX "PackageAddOn_isActive_sortOrder_idx" ON "PackageAddOn"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PackageSale_reference_key" ON "PackageSale"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PackageSale_paymentToken_key" ON "PackageSale"("paymentToken");

-- CreateIndex
CREATE INDEX "PackageSale_advertiserId_status_idx" ON "PackageSale"("advertiserId", "status");

-- CreateIndex
CREATE INDEX "PackageSale_agentId_idx" ON "PackageSale"("agentId");

-- CreateIndex
CREATE INDEX "PackageSale_status_nextBillingAt_idx" ON "PackageSale"("status", "nextBillingAt");

-- CreateIndex
CREATE INDEX "PackageSaleLine_saleId_idx" ON "PackageSaleLine"("saleId");

-- AddForeignKey
ALTER TABLE "PackageSale" ADD CONSTRAINT "PackageSale_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSale" ADD CONSTRAINT "PackageSale_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSale" ADD CONSTRAINT "PackageSale_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSale" ADD CONSTRAINT "PackageSale_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "AdvertiserPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSaleLine" ADD CONSTRAINT "PackageSaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "PackageSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
