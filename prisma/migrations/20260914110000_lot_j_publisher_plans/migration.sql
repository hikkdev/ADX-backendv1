-- Lot J: publisher subscription plans, self-service orders, publisher-payable payments.
CREATE TYPE "SubscriptionSource" AS ENUM ('ADMIN_GRANT', 'SELF_SERVICE');
CREATE TYPE "PublisherSubscriptionOrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED');

ALTER TABLE "PublisherSubscription" ADD COLUMN "source" "SubscriptionSource" NOT NULL DEFAULT 'ADMIN_GRANT';

CREATE TABLE "PublisherSubscriptionPlan" (
  "id" TEXT NOT NULL,
  "tier" "SubscriptionTierName" NOT NULL,
  "name" TEXT NOT NULL,
  "pricePerMonth" DECIMAL(14,2) NOT NULL,
  "ratePct" DECIMAL(5,4) NOT NULL,
  "description" TEXT,
  "isPopular" BOOLEAN NOT NULL DEFAULT false,
  "entitlements" JSONB NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublisherSubscriptionPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublisherSubscriptionPlan_tier_key" ON "PublisherSubscriptionPlan"("tier");
CREATE INDEX "PublisherSubscriptionPlan_isActive_sortOrder_idx" ON "PublisherSubscriptionPlan"("isActive", "sortOrder");

CREATE TABLE "PublisherSubscriptionOrder" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "tier" "SubscriptionTierName" NOT NULL,
  "planName" TEXT NOT NULL,
  "pricePerMonth" DECIMAL(14,2) NOT NULL,
  "ratePct" DECIMAL(5,4) NOT NULL,
  "cycle" "PackageBillingCycle" NOT NULL DEFAULT 'MONTHLY',
  "months" INTEGER NOT NULL DEFAULT 1,
  "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "gstPct" DECIMAL(5,2) NOT NULL DEFAULT 18,
  "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "status" "PublisherSubscriptionOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "startsAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "paidMethod" TEXT,
  "paidReference" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "subscriptionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublisherSubscriptionOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublisherSubscriptionOrder_reference_key" ON "PublisherSubscriptionOrder"("reference");
CREATE UNIQUE INDEX "PublisherSubscriptionOrder_subscriptionId_key" ON "PublisherSubscriptionOrder"("subscriptionId");
CREATE INDEX "PublisherSubscriptionOrder_publisherId_createdAt_idx" ON "PublisherSubscriptionOrder"("publisherId", "createdAt");
CREATE INDEX "PublisherSubscriptionOrder_status_createdAt_idx" ON "PublisherSubscriptionOrder"("status", "createdAt");
ALTER TABLE "PublisherSubscriptionOrder" ADD CONSTRAINT "PublisherSubscriptionOrder_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublisherSubscriptionOrder" ADD CONSTRAINT "PublisherSubscriptionOrder_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PublisherSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment" ALTER COLUMN "advertiserId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN "publisherId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "subscriptionOrderId" TEXT;
CREATE INDEX "Payment_publisherId_createdAt_idx" ON "Payment"("publisherId", "createdAt");
CREATE INDEX "Payment_subscriptionOrderId_idx" ON "Payment"("subscriptionOrderId");
