-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('NO_SUITABLE_ALTERNATIVE', 'PUBLISHER_WITHDREW', 'ADVERTISER_LEAVING', 'OTHER');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterEnum
ALTER TYPE "WalletEntryType" ADD VALUE 'EXPIRY';

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "lastActivityAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WalletRefundRequest" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "note" TEXT NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'PENDING',
    "holdId" TEXT,
    "ticketId" TEXT,
    "raisedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletRefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletRefundRequest_holdId_key" ON "WalletRefundRequest"("holdId");

-- CreateIndex
CREATE INDEX "WalletRefundRequest_status_createdAt_idx" ON "WalletRefundRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WalletRefundRequest_walletId_idx" ON "WalletRefundRequest"("walletId");

-- CreateIndex
CREATE INDEX "Wallet_lastActivityAt_idx" ON "Wallet"("lastActivityAt");

-- AddForeignKey
ALTER TABLE "WalletRefundRequest" ADD CONSTRAINT "WalletRefundRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletRefundRequest" ADD CONSTRAINT "WalletRefundRequest_raisedByUserId_fkey" FOREIGN KEY ("raisedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletRefundRequest" ADD CONSTRAINT "WalletRefundRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
