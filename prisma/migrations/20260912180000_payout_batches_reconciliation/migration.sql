-- Lot B (Q35/Q36): payouts leave in batches — approval reserves, release
-- debits — drawn on ADX's own bank accounts, whose statements come back as
-- lines to be matched against withdrawals, top-ups, payments and the ledger.
CREATE TYPE "PayoutBatchStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASING', 'RELEASED', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');
CREATE TYPE "BankLineDirection" AS ENUM ('CREDIT', 'DEBIT');
CREATE TYPE "BankLineMatchStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'DIFFERS', 'IGNORED');
CREATE TYPE "ReconciliationMatchKind" AS ENUM ('AUTO', 'MANUAL');

CREATE TABLE "BankAccount" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountHolder" TEXT,
  "accountNumberMasked" TEXT NOT NULL,
  "ifsc" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutBatch" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "status" "PayoutBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "rail" "PayoutRailName" NOT NULL,
  "bankAccountId" TEXT,
  "cutoffAt" TIMESTAMP(3),
  "scheduledFor" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lineCount" INTEGER NOT NULL DEFAULT 0,
  "totalNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "exportFileId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayoutBatch_reference_key" ON "PayoutBatch"("reference");
CREATE INDEX "PayoutBatch_status_createdAt_idx" ON "PayoutBatch"("status", "createdAt");
-- Four eyes: the approver is never the builder.
ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_four_eyes"
  CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "createdByUserId");

ALTER TABLE "WithdrawalRequest"
  ADD COLUMN "batchId" TEXT,
  ADD COLUMN "reservedAt" TIMESTAMP(3);
CREATE INDEX "WithdrawalRequest_batchId_idx" ON "WithdrawalRequest"("batchId");
ALTER TABLE "WithdrawalRequest"
  ADD CONSTRAINT "WithdrawalRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BankStatementProfile" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "columns" JSONB NOT NULL,
  "dateFormat" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankStatementProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankStatementProfile_name_key" ON "BankStatementProfile"("name");

CREATE TABLE "BankStatementImport" (
  "id" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "profileId" TEXT,
  "fileId" TEXT,
  "fileName" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "lineCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "importedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BankStatementImport_bankAccountId_createdAt_idx" ON "BankStatementImport"("bankAccountId", "createdAt");
ALTER TABLE "BankStatementImport"
  ADD CONSTRAINT "BankStatementImport_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BankStatementLine" (
  "id" TEXT NOT NULL,
  "importId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "valueDate" DATE NOT NULL,
  "description" TEXT NOT NULL,
  "utr" TEXT,
  "direction" "BankLineDirection" NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "runningBalance" DECIMAL(14,2),
  "rawHash" TEXT NOT NULL,
  "matchStatus" "BankLineMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankStatementLine_bankAccountId_rawHash_key" ON "BankStatementLine"("bankAccountId", "rawHash");
CREATE INDEX "BankStatementLine_matchStatus_valueDate_idx" ON "BankStatementLine"("matchStatus", "valueDate");
CREATE INDEX "BankStatementLine_utr_idx" ON "BankStatementLine"("utr");
ALTER TABLE "BankStatementLine"
  ADD CONSTRAINT "BankStatementLine_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BankStatementLine_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReconciliationMatch" (
  "id" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "ledgerTransactionId" TEXT,
  "withdrawalId" TEXT,
  "topUpId" TEXT,
  "paymentId" TEXT,
  "difference" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "kind" "ReconciliationMatchKind" NOT NULL,
  "matchedByUserId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationMatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReconciliationMatch_lineId_key" ON "ReconciliationMatch"("lineId");
CREATE INDEX "ReconciliationMatch_withdrawalId_idx" ON "ReconciliationMatch"("withdrawalId");
CREATE INDEX "ReconciliationMatch_topUpId_idx" ON "ReconciliationMatch"("topUpId");
ALTER TABLE "ReconciliationMatch"
  ADD CONSTRAINT "ReconciliationMatch_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "BankStatementLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
