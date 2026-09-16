-- CreateEnum
CREATE TYPE "PayoutMethodType" AS ENUM ('BANK', 'UPI');

-- CreateEnum
CREATE TYPE "PayoutMethodStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutVerificationMethod" AS ENUM ('PENNY_DROP', 'NAME_LOOKUP', 'MANUAL');

-- CreateEnum
CREATE TYPE "PartySizeBand" AS ENUM ('INDIVIDUAL', 'SMALL_AGENCY', 'LARGE_AGENCY');

-- CreateEnum
CREATE TYPE "TaxParty" AS ENUM ('PUBLISHER', 'AGENT');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutRailName" AS ENUM ('MANUAL_NEFT', 'RAZORPAY_X', 'CASHFREE');

-- CreateEnum
CREATE TYPE "IncentiveEvent" AS ENUM ('PUBLISHER_ONBOARDED', 'SITE_VISIT', 'CAMPAIGN_ASSIST', 'MILESTONE_BONUS');

-- CreateEnum
CREATE TYPE "IncentiveStatus" AS ENUM ('PENDING_VERIFICATION', 'CREDITED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "BankAccount" DROP CONSTRAINT "BankAccount_userId_fkey";

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "sizeBand" "PartySizeBand" NOT NULL DEFAULT 'INDIVIDUAL';

-- DropTable
DROP TABLE "BankAccount";

-- CreateTable
CREATE TABLE "PayoutMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PayoutMethodType" NOT NULL DEFAULT 'BANK',
    "accountHolder" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifscCode" TEXT,
    "upiVpa" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "PayoutMethodStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verifiedVia" "PayoutVerificationMethod",
    "verificationReference" TEXT,
    "nameMatchPct" DECIMAL(5,2),
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalLimit" (
    "id" TEXT NOT NULL,
    "band" "PartySizeBand" NOT NULL,
    "minMonths" INTEGER NOT NULL,
    "dailyCap" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxWithholdingRate" (
    "id" TEXT NOT NULL,
    "appliesTo" "TaxParty" NOT NULL,
    "section" TEXT NOT NULL,
    "ratePct" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxWithholdingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarningAccrual" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "campaignSpotId" TEXT NOT NULL,
    "forDate" DATE NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "commission" DECIMAL(14,2) NOT NULL,
    "taxWithheld" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(14,2) NOT NULL,
    "commissionRatePct" DECIMAL(5,2) NOT NULL,
    "taxRatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "clearsAt" TIMESTAMP(3) NOT NULL,
    "walletEntryId" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "payoutMethodId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxWithheld" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxSection" TEXT,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "rail" "PayoutRailName",
    "railReference" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveRate" (
    "id" TEXT NOT NULL,
    "event" "IncentiveEvent" NOT NULL,
    "tier" TEXT NOT NULL DEFAULT '*',
    "amount" DECIMAL(14,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncentiveRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIncentive" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "event" "IncentiveEvent" NOT NULL,
    "tier" TEXT NOT NULL,
    "rateId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "taxWithheld" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxRatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(14,2) NOT NULL,
    "status" "IncentiveStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "orderId" TEXT,
    "publisherId" TEXT,
    "advertiserId" TEXT,
    "note" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "walletEntryId" TEXT,
    "ledgerTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIncentive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "openingBalance" DECIMAL(14,2) NOT NULL,
    "credits" DECIMAL(14,2) NOT NULL,
    "debits" DECIMAL(14,2) NOT NULL,
    "taxWithheld" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closingBalance" DECIMAL(14,2) NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "csvPath" TEXT,
    "pdfPath" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutMethod_userId_status_idx" ON "PayoutMethod"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalLimit_band_minMonths_key" ON "WithdrawalLimit"("band", "minMonths");

-- CreateIndex
CREATE INDEX "TaxWithholdingRate_appliesTo_effectiveFrom_idx" ON "TaxWithholdingRate"("appliesTo", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EarningAccrual_publisherId_forDate_idx" ON "EarningAccrual"("publisherId", "forDate");

-- CreateIndex
CREATE INDEX "EarningAccrual_clearsAt_idx" ON "EarningAccrual"("clearsAt");

-- CreateIndex
CREATE UNIQUE INDEX "EarningAccrual_campaignSpotId_forDate_key" ON "EarningAccrual"("campaignSpotId", "forDate");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_reference_key" ON "WithdrawalRequest"("reference");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_walletId_status_idx" ON "WithdrawalRequest"("walletId", "status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_requestedAt_idx" ON "WithdrawalRequest"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "IncentiveRate_event_tier_effectiveFrom_idx" ON "IncentiveRate"("event", "tier", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AgentIncentive_agentId_status_idx" ON "AgentIncentive"("agentId", "status");

-- CreateIndex
CREATE INDEX "AgentIncentive_status_createdAt_idx" ON "AgentIncentive"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_reference_key" ON "Statement"("reference");

-- CreateIndex
CREATE INDEX "Statement_walletId_periodStart_idx" ON "Statement"("walletId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "Statement_walletId_periodStart_key" ON "Statement"("walletId", "periodStart");

-- AddForeignKey
ALTER TABLE "PayoutMethod" ADD CONSTRAINT "PayoutMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningAccrual" ADD CONSTRAINT "EarningAccrual_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningAccrual" ADD CONSTRAINT "EarningAccrual_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarningAccrual" ADD CONSTRAINT "EarningAccrual_campaignSpotId_fkey" FOREIGN KEY ("campaignSpotId") REFERENCES "CampaignSpot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "PayoutMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIncentive" ADD CONSTRAINT "AgentIncentive_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIncentive" ADD CONSTRAINT "AgentIncentive_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "IncentiveRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- Invariants the money depends on
--
-- BankAccount is dropped rather than renamed because it held no rows: the
-- module was built and never given a client. PayoutMethod replaces it and adds
-- UPI, which DR 04 draws beside bank on the same screen.
-- ────────────────────────────────────────────────────────────────────

-- A method carries the fields for the kind it is, and not the other kind's.
ALTER TABLE "PayoutMethod"
  ADD CONSTRAINT "PayoutMethod_fields_match_type" CHECK (
    ("type" = 'BANK' AND "accountHolder" IS NOT NULL AND "bankName" IS NOT NULL
       AND "accountNumber" IS NOT NULL AND "ifscCode" IS NOT NULL AND "upiVpa" IS NULL)
    OR
    ("type" = 'UPI' AND "upiVpa" IS NOT NULL
       AND "accountNumber" IS NULL AND "ifscCode" IS NULL)
  );

-- A verified method says how it was verified and when; a rejected one says why.
ALTER TABLE "PayoutMethod"
  ADD CONSTRAINT "PayoutMethod_verification_is_explained" CHECK (
    ("status" <> 'VERIFIED' OR ("verifiedVia" IS NOT NULL AND "verifiedAt" IS NOT NULL))
    AND
    ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL)
  );

-- Withdrawals move a positive amount, and the arithmetic on the row holds.
ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_net_is_amount_less_tax"
  CHECK ("netAmount" = "amount" - "taxWithheld" AND "taxWithheld" >= 0);

-- Paid means paid: a rail and its reference, or it is not paid.
ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_paid_is_traceable" CHECK (
    "status" <> 'PAID' OR ("paidAt" IS NOT NULL AND "rail" IS NOT NULL AND "railReference" IS NOT NULL)
  );

-- A decision has a decider.
ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_decision_has_an_author" CHECK (
    "status" NOT IN ('APPROVED', 'REJECTED') OR ("decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
  );

-- A day's earning splits exactly: what the advertiser paid is what the three
-- parts add back up to.
ALTER TABLE "EarningAccrual"
  ADD CONSTRAINT "EarningAccrual_splits_exactly"
  CHECK ("net" = "gross" - "commission" - "taxWithheld");

ALTER TABLE "EarningAccrual"
  ADD CONSTRAINT "EarningAccrual_parts_non_negative"
  CHECK ("gross" >= 0 AND "commission" >= 0 AND "taxWithheld" >= 0 AND "net" >= 0);

-- An incentive nets the same way.
ALTER TABLE "AgentIncentive"
  ADD CONSTRAINT "AgentIncentive_net_is_amount_less_tax"
  CHECK ("netAmount" = "amount" - "taxWithheld" AND "amount" > 0 AND "taxWithheld" >= 0);

ALTER TABLE "AgentIncentive"
  ADD CONSTRAINT "AgentIncentive_rejection_is_explained"
  CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL);

-- A cap is a cap.
ALTER TABLE "WithdrawalLimit"
  ADD CONSTRAINT "WithdrawalLimit_cap_positive" CHECK ("dailyCap" > 0 AND "minMonths" >= 0);

-- Rates are percentages.
ALTER TABLE "TaxWithholdingRate"
  ADD CONSTRAINT "TaxWithholdingRate_pct_in_range" CHECK ("ratePct" >= 0 AND "ratePct" <= 100);

ALTER TABLE "TaxWithholdingRate"
  ADD CONSTRAINT "TaxWithholdingRate_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "IncentiveRate"
  ADD CONSTRAINT "IncentiveRate_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "IncentiveRate"
  ADD CONSTRAINT "IncentiveRate_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- A statement covers a period and balances across it.
ALTER TABLE "Statement"
  ADD CONSTRAINT "Statement_period_ordered" CHECK ("periodEnd" > "periodStart");

ALTER TABLE "Statement"
  ADD CONSTRAINT "Statement_closes_from_opening"
  CHECK ("closingBalance" = "openingBalance" + "credits" - "debits");
