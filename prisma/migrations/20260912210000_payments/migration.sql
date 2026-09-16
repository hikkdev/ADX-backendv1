-- Lot C (Q12/Q47/Q88/Q110): one attempt to pay through a gateway; the campaign
-- an advertiser is asked to pay for; a 24-hour reservation on its spots; every
-- webhook once.
ALTER TYPE "PackagePaymentMethod" ADD VALUE 'GATEWAY';
CREATE TYPE "PaymentGateway" AS ENUM ('RAZORPAY', 'CASHFREE', 'CCAVENUE');
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "PaymentRefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "advertiserId" TEXT NOT NULL,
  "campaignId" TEXT,
  "packageSaleId" TEXT,
  "gateway" "PaymentGateway" NOT NULL,
  "gatewayOrderId" TEXT,
  "gatewayPaymentId" TEXT,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "method" TEXT,
  "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
  "failureReason" TEXT,
  "topUpId" TEXT,
  "walletEntryId" TEXT,
  "ledgerTransactionId" TEXT,
  "invoiceId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");
CREATE INDEX "Payment_advertiserId_createdAt_idx" ON "Payment"("advertiserId", "createdAt");
CREATE INDEX "Payment_campaignId_idx" ON "Payment"("campaignId");
CREATE INDEX "Payment_packageSaleId_idx" ON "Payment"("packageSaleId");
CREATE INDEX "Payment_gateway_gatewayOrderId_idx" ON "Payment"("gateway", "gatewayOrderId");
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive" CHECK ("amount" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_captured_is_dated" CHECK ("status" <> 'CAPTURED' OR "capturedAt" IS NOT NULL);

CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "gatewayRefundId" TEXT,
  "status" "PaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "refundRequestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "gateway" "PaymentGateway" NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "outcome" TEXT,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_gateway_eventId_key" ON "WebhookEvent"("gateway", "eventId");
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

ALTER TABLE "Campaign"
  ADD COLUMN "submittedForPaymentAt" TIMESTAMP(3),
  ADD COLUMN "submittedByUserId" TEXT;
ALTER TABLE "CampaignSpot" ADD COLUMN "reservedUntil" TIMESTAMP(3);
