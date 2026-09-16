-- Lot B (Q41/Q11): a recorded bank transfer is a structured fact (UTR, date,
-- account, proof), a refund says where it goes and who agreed, a cancelled
-- captured campaign waits for finance to credit it back, and a payout method
-- remembers what the IFSC directory said.
ALTER TYPE "RefundRequestStatus" ADD VALUE 'PAID';
ALTER TYPE "RefundRequestStatus" ADD VALUE 'FAILED';
CREATE TYPE "RefundDestination" AS ENUM ('WALLET_CREDIT', 'BANK_TRANSFER', 'ORIGINAL_METHOD');
CREATE TYPE "TopUpMethod" AS ENUM ('BANK_TRANSFER', 'CHEQUE', 'GATEWAY');
CREATE TYPE "CampaignRefundStatus" AS ENUM ('PENDING', 'RELEASED', 'REJECTED');

CREATE TABLE "WalletTopUp" (
  "id" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "method" "TopUpMethod" NOT NULL,
  "utr" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "bankAccountId" TEXT,
  "proofFileId" TEXT,
  "paymentId" TEXT,
  "note" TEXT,
  "recordedByUserId" TEXT NOT NULL,
  "walletEntryId" TEXT,
  "ledgerTransactionId" TEXT,
  "reconciledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletTopUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletTopUp_walletId_receivedAt_idx" ON "WalletTopUp"("walletId", "receivedAt");
CREATE INDEX "WalletTopUp_utr_idx" ON "WalletTopUp"("utr");
ALTER TABLE "WalletTopUp"
  ADD CONSTRAINT "WalletTopUp_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletTopUp" ADD CONSTRAINT "WalletTopUp_positive" CHECK ("amount" > 0);
ALTER TABLE "WalletTopUp" ADD CONSTRAINT "WalletTopUp_bank_transfer_has_utr"
  CHECK ("method" <> 'BANK_TRANSFER' OR "utr" IS NOT NULL);

CREATE TABLE "CampaignRefund" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "status" "CampaignRefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "releasedByUserId" TEXT,
  "releasedAt" TIMESTAMP(3),
  "ledgerTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CampaignRefund_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampaignRefund_campaignId_key" ON "CampaignRefund"("campaignId");
CREATE INDEX "CampaignRefund_status_createdAt_idx" ON "CampaignRefund"("status", "createdAt");

ALTER TABLE "WalletRefundRequest"
  ADD COLUMN "destination" "RefundDestination" NOT NULL DEFAULT 'WALLET_CREDIT',
  ADD COLUMN "consentNote" TEXT,
  ADD COLUMN "payoutMethodId" TEXT,
  ADD COLUMN "rail" "PayoutRailName",
  ADD COLUMN "railReference" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paidByUserId" TEXT,
  ADD COLUMN "ledgerTransactionId" TEXT;
-- Money leaving ADX for a bank account needs the consumer's recorded agreement.
ALTER TABLE "WalletRefundRequest" ADD CONSTRAINT "WalletRefundRequest_offline_has_consent"
  CHECK ("destination" = 'WALLET_CREDIT' OR "consentNote" IS NOT NULL);

ALTER TABLE "PayoutMethod"
  ADD COLUMN "bankBranch" TEXT,
  ADD COLUMN "ifscVerifiedAt" TIMESTAMP(3);
