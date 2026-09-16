-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletEntryType" ADD VALUE 'EARNING';
ALTER TYPE "WalletEntryType" ADD VALUE 'BONUS';
ALTER TYPE "WalletEntryType" ADD VALUE 'REFERRAL';
ALTER TYPE "WalletEntryType" ADD VALUE 'PAYOUT';
ALTER TYPE "WalletEntryType" ADD VALUE 'PENALTY';
