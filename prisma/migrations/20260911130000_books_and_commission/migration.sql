-- DR 06 wave 7: the agent's two books, and the package-sale commission.
--
-- "₹2,500 comm." on a package-sale card had no source: IncentiveEvent had no
-- package-sale value (decision 16). PACKAGE_SOLD is priced in the rate table
-- like every other incentive, recorded when the sale is paid, and the sale
-- keeps the incentive it produced so the card prints the figure the wallet
-- will show.
--
-- "Check in" and "Follow up" on an advertiser row are CRM actions against an
-- account that is already onboarded, not a lead (decision 14). AccountActivity
-- is their log — one row per action, against exactly one account.

ALTER TYPE "IncentiveEvent" ADD VALUE IF NOT EXISTS 'PACKAGE_SOLD';

ALTER TABLE "PackageSale" ADD COLUMN "incentiveId" TEXT;
CREATE UNIQUE INDEX "PackageSale_incentiveId_key" ON "PackageSale"("incentiveId");

CREATE TYPE "AccountActivityKind" AS ENUM ('CHECK_IN', 'FOLLOW_UP', 'CALLED', 'MESSAGED', 'NOTE');

CREATE TABLE "AccountActivity" (
  "id" TEXT NOT NULL,
  "advertiserId" TEXT,
  "publisherId" TEXT,
  "agentId" TEXT NOT NULL,
  "kind" "AccountActivityKind" NOT NULL,
  "note" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT NOT NULL,
  CONSTRAINT "AccountActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountActivity_one_party" CHECK (("advertiserId" IS NULL) <> ("publisherId" IS NULL)),
  CONSTRAINT "AccountActivity_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "Advertiser"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountActivity_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountActivity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AccountActivity_advertiserId_at_idx" ON "AccountActivity"("advertiserId", "at");
CREATE INDEX "AccountActivity_publisherId_at_idx" ON "AccountActivity"("publisherId", "at");
CREATE INDEX "AccountActivity_agentId_at_idx" ON "AccountActivity"("agentId", "at");
