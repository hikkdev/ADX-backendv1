-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('WALLET', 'PLATFORM');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('TOPUP', 'CAMPAIGN_SPEND', 'PACKAGE_SPEND', 'PUBLISHER_EARNING', 'AGENT_INCENTIVE', 'PAYOUT', 'REFUND', 'GOODWILL', 'PENALTY', 'ADJUSTMENT', 'EXPIRY', 'REVERSAL');

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "walletId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "LedgerTransactionKind" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reversesId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerLeg" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "campaignId" TEXT,
    "orderId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_walletId_key" ON "LedgerAccount"("walletId");

-- CreateIndex
CREATE INDEX "LedgerAccount_kind_idx" ON "LedgerAccount"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_reference_key" ON "LedgerTransaction"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_reversesId_key" ON "LedgerTransaction"("reversesId");

-- CreateIndex
CREATE INDEX "LedgerTransaction_kind_occurredAt_idx" ON "LedgerTransaction"("kind", "occurredAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_occurredAt_idx" ON "LedgerTransaction"("occurredAt");

-- CreateIndex
CREATE INDEX "LedgerLeg_transactionId_idx" ON "LedgerLeg"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerLeg_accountId_createdAt_idx" ON "LedgerLeg"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerLeg_campaignId_idx" ON "LedgerLeg"("campaignId");

-- CreateIndex
CREATE INDEX "LedgerLeg_orderId_idx" ON "LedgerLeg"("orderId");

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction" ADD CONSTRAINT "LedgerTransaction_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLeg" ADD CONSTRAINT "LedgerLeg_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerLeg" ADD CONSTRAINT "LedgerLeg_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- What makes this a ledger rather than a table of rows
-- ────────────────────────────────────────────────────────────────────

-- 1. Append-only, enforced rather than agreed.
--
-- A service can be careful; a psql session at 2am cannot be trusted to be. An
-- error is corrected by posting its reversal, which leaves both the mistake and
-- the correction on the record. That is the only version that survives an audit.
CREATE OR REPLACE FUNCTION adx_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'The ledger is append-only. Post a reversing transaction instead of changing %.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerTransaction_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION adx_ledger_append_only();

CREATE TRIGGER "LedgerLeg_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerLeg"
  FOR EACH ROW EXECUTE FUNCTION adx_ledger_append_only();

-- 2. A leg never moves nothing.
ALTER TABLE "LedgerLeg"
  ADD CONSTRAINT "LedgerLeg_amount_non_zero" CHECK ("amount" <> 0);

-- 3. Every transaction balances.
--
-- Deferred to commit on purpose: legs are inserted one at a time inside the same
-- database transaction, so a check that fired per row would reject the first leg
-- of every valid pair. Checked as a set, at the only moment the set is complete.
CREATE OR REPLACE FUNCTION adx_ledger_balanced() RETURNS trigger AS $$
DECLARE
  total NUMERIC(14,2);
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO total
    FROM "LedgerLeg" WHERE "transactionId" = NEW."transactionId";

  IF total <> 0 THEN
    RAISE EXCEPTION
      'Ledger transaction % does not balance: legs sum to %, expected 0.',
      NEW."transactionId", total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerLeg_balances"
  AFTER INSERT ON "LedgerLeg"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adx_ledger_balanced();

-- 4. A transaction that reverses another must say so in its kind, and nothing
--    may reverse itself.
ALTER TABLE "LedgerTransaction"
  ADD CONSTRAINT "LedgerTransaction_reversal_is_marked"
  CHECK (("reversesId" IS NULL) = ("kind" <> 'REVERSAL'));

ALTER TABLE "LedgerTransaction"
  ADD CONSTRAINT "LedgerTransaction_not_self_reversing"
  CHECK ("reversesId" IS NULL OR "reversesId" <> "id");

-- 5. A wallet account carries its wallet; a platform account never does.
ALTER TABLE "LedgerAccount"
  ADD CONSTRAINT "LedgerAccount_wallet_kind_agrees"
  CHECK (("kind" = 'WALLET') = ("walletId" IS NOT NULL));
