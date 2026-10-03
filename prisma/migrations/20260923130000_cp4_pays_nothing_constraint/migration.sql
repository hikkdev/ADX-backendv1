-- CP-4 (23 Sep 2026): a rate may be zero only when it is explicitly switched off.
--
-- `IncentiveRate_amount_positive` (DR 04) refuses `amount = 0`, and it is right
-- to: a rate of zero set by accident pays nobody and looks like a price. CP-4's
-- off rows are zero ON PURPOSE, and are marked as such, so the constraint is
-- widened by exactly that much rather than dropped.
--
-- Found by a probe against the real database: every unit test above this ran
-- against a fake repository and never met the constraint at all.

ALTER TABLE "IncentiveRate" DROP CONSTRAINT IF EXISTS "IncentiveRate_amount_positive";
ALTER TABLE "IncentiveRate"
  ADD CONSTRAINT "IncentiveRate_amount_positive" CHECK ("amount" > 0 OR "paysNothing");
