-- Lot E addendum: what the Lot D packages asked for once they had built.
ALTER TYPE "PartyType" ADD VALUE 'FRAUD_CASE';
ALTER TABLE "FraudCase" ADD COLUMN "appliedScopes" "SuspensionScope"[] NOT NULL DEFAULT ARRAY[]::"SuspensionScope"[];
ALTER TABLE "UserKyc" ADD COLUMN "fileId" TEXT;
ALTER TABLE "PublisherImport" ADD COLUMN "warningCount" INTEGER NOT NULL DEFAULT 0;
