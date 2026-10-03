-- RF-1 (25 Sep 2026): the reservation fee on a big checkout.
-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('SETTLEMENT', 'RESERVATION_FEE');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'SETTLEMENT';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "reservationFeeAmount" DECIMAL(14,2),
ADD COLUMN "reservationFeeStatus" TEXT,
ADD COLUMN "reservationFeeDueAt" TIMESTAMP(3),
ADD COLUMN "reservationFeePaidAt" TIMESTAMP(3),
ADD COLUMN "reservationFeeHoldId" TEXT,
ADD COLUMN "reservationHoldUntil" TIMESTAMP(3),
ADD COLUMN "reservationFeeRetained" DECIMAL(14,2),
ADD COLUMN "reservationFeeSettledAt" TIMESTAMP(3),
ADD COLUMN "reservationFeePaymentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_reservationFeeHoldId_key" ON "Campaign"("reservationFeeHoldId");
