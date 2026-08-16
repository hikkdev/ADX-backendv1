-- AlterTable: extend PublisherKyc with legacy AdSpaceKyc business/NGO document fields
ALTER TABLE "PublisherKyc"
  ADD COLUMN "businessRegCertUrl" TEXT,
  ADD COLUMN "directorIdUrl" TEXT,
  ADD COLUMN "businessAddressProofUrl" TEXT,
  ADD COLUMN "adAuthLetterUrl" TEXT,
  ADD COLUMN "ngoRegCertUrl" TEXT,
  ADD COLUMN "ngoAddressProofUrl" TEXT,
  ADD COLUMN "ngoTaxExemptionCertUrl" TEXT,
  ADD COLUMN "ngoOperationalOverviewUrl" TEXT;
