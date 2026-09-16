-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "publisherId" TEXT,
ALTER COLUMN "advertiserId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WalletEntry" ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_publisherId_key" ON "Wallet"("publisherId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_agentId_key" ON "Wallet"("agentId");

-- CreateIndex
CREATE INDEX "WalletEntry_orderId_idx" ON "WalletEntry"("orderId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Absorb the agent-only Transaction ledger into the shared wallet.
--
-- One wallet per agent that has ever transacted, its balance the sum of that
-- agent's rows, and one WalletEntry per Transaction with balanceAfter
-- reconstructed as a running total in the order the rows were written.
--
-- "Transaction" is deliberately left in place and simply stops being read.
-- Dropping a money table in the same change that migrates it would leave
-- nothing to reconcile the new numbers against; that is a separate, deliberate
-- step once the totals have been checked.
-- ---------------------------------------------------------------------------

INSERT INTO "Wallet" ("id", "agentId", "balance", "goodwill", "currency", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  t."agentId",
  COALESCE(SUM(t."amount"), 0)::numeric(14,2),
  0,
  'INR',
  MIN(t."createdAt"),
  NOW()
FROM "Transaction" t
GROUP BY t."agentId"
ON CONFLICT ("agentId") DO NOTHING;

INSERT INTO "WalletEntry" ("id", "walletId", "type", "amount", "balanceAfter", "isGoodwill", "orderId", "note", "createdAt")
SELECT
  gen_random_uuid()::text,
  w."id",
  (CASE t."type"
     WHEN 'ORDER_COMPLETION' THEN 'EARNING'
     WHEN 'BONUS'            THEN 'BONUS'
     WHEN 'REFERRAL'         THEN 'REFERRAL'
     WHEN 'PAYOUT'           THEN 'PAYOUT'
     ELSE 'ADJUSTMENT'
   END)::"WalletEntryType",
  t."amount"::numeric(14,2),
  (SUM(t."amount") OVER (
     PARTITION BY t."agentId"
     ORDER BY t."createdAt", t."id"
     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
   ))::numeric(14,2),
  false,
  t."orderId",
  t."title",
  t."createdAt"
FROM "Transaction" t
JOIN "Wallet" w ON w."agentId" = t."agentId";

-- ---------------------------------------------------------------------------
-- Exactly one owner. Prisma has no syntax for a CHECK, and without it the three
-- nullable keys would permit a wallet owned by nobody, or by two parties at
-- once. Added last so the rows migrated above are covered by it.
-- ---------------------------------------------------------------------------

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_exactly_one_owner" CHECK (
  (("advertiserId" IS NOT NULL)::int
   + ("publisherId" IS NOT NULL)::int
   + ("agentId" IS NOT NULL)::int) = 1
);
