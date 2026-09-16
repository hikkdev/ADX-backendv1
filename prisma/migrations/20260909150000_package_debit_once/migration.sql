-- One package sale is charged once.
--
-- debitForPackage looks for an existing PACKAGE_DEBIT before it moves a balance,
-- which answers a second tap arriving after the first has committed. Two arriving
-- together read the same empty result, so the database has to be the one that
-- refuses. A sale writes at most two entries -- one from goodwill, one from
-- settled balance -- so the pair is what is unique, not the reference alone.
--
-- Partial, because "reference" is a free field on every other entry type and ops
-- legitimately credit twice against the same one. Prisma cannot express a partial
-- index, so this lives here rather than in schema.prisma, the way the wallet's
-- exactly-one-owner CHECK does.
CREATE UNIQUE INDEX "WalletEntry_package_debit_once"
  ON "WalletEntry" ("reference", "isGoodwill")
  WHERE "type" = 'PACKAGE_DEBIT' AND "reference" IS NOT NULL;
