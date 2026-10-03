-- Onboarding addresses (the owner, 1 Oct 2026): one address search bar on
-- every onboarding flow, filling the address all the way to the PIN code.
--
-- The publisher and the agent application had no PIN column, and the print
-- partner had neither state nor PIN. All nullable: existing rows keep what
-- they have, and a hand-typed address may leave them empty.
ALTER TABLE "Publisher" ADD COLUMN "postalCode" TEXT;
ALTER TABLE "PrintPartner" ADD COLUMN "state" TEXT;
ALTER TABLE "PrintPartner" ADD COLUMN "postalCode" TEXT;
ALTER TABLE "AgentProfile" ADD COLUMN "currentPostalCode" TEXT;
