-- AB-3 (25 Sep 2026): the weekly campaign summary, where a session signed in from, the payer's UPI id.
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'WEEKLY_SUMMARY';

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "city" TEXT,
ADD COLUMN "region" TEXT,
ADD COLUMN "country" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "payerUpiId" TEXT;
