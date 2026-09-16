-- DR 08 self-service onboarding. The frames let a publisher or advertiser
-- choose which government ID they hold, print the PAN as a string, take a
-- signature and a live selfie, and give a GSTIN and a contact person for an
-- account that is not a person. None of that had a column. The same seven
-- capture fields go on both KYC rows so the one ladder differs in data, not
-- in code; the advertiser row also gains the address-proof URL the publisher
-- row already had.

-- AlterTable
ALTER TABLE "Publisher"
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "contactMobile" TEXT,
  ADD COLUMN "contactEmail" TEXT;

-- AlterTable
ALTER TABLE "PublisherKyc"
  ADD COLUMN "govIdType" TEXT,
  ADD COLUMN "govIdFrontUrl" TEXT,
  ADD COLUMN "govIdBackUrl" TEXT,
  ADD COLUMN "panNumber" TEXT,
  ADD COLUMN "panSignatureUrl" TEXT,
  ADD COLUMN "addressProofType" TEXT,
  ADD COLUMN "selfieUrl" TEXT;

-- AlterTable
ALTER TABLE "AdvertiserKyc"
  ADD COLUMN "govIdType" TEXT,
  ADD COLUMN "govIdFrontUrl" TEXT,
  ADD COLUMN "govIdBackUrl" TEXT,
  ADD COLUMN "panNumber" TEXT,
  ADD COLUMN "panSignatureUrl" TEXT,
  ADD COLUMN "addressProofType" TEXT,
  ADD COLUMN "addressProofUrl" TEXT,
  ADD COLUMN "selfieUrl" TEXT;
