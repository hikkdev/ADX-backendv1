-- Lot D (Q55/Q123): an agreement for every transaction. The two live uniques
-- said a party accepts a template once — true for platform terms, wrong for a
-- second campaign on the same insertion-order version. Partial indexes say it
-- properly: platform scope once per party per version; each transaction once.
ALTER TYPE "AgreementKind" ADD VALUE 'PACKAGE_SALE';
ALTER TYPE "AgreementKind" ADD VALUE 'JOB_TERMS';
CREATE TYPE "SignatureProvider" AS ENUM ('NONE', 'DIGIO');

ALTER TABLE "AgreementTemplate" ADD COLUMN "requiresReacceptance" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgreementAcceptance"
  ADD COLUMN "agentId" TEXT,
  ADD COLUMN "packageSaleId" TEXT,
  ADD COLUMN "orderId" TEXT,
  ADD COLUMN "signatureProvider" "SignatureProvider" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "signatureRef" TEXT;

DROP INDEX IF EXISTS "AgreementAcceptance_publisherId_templateId_key";
DROP INDEX IF EXISTS "AgreementAcceptance_advertiserId_templateId_key";
DROP INDEX IF EXISTS "AgreementAcceptance_attemptId_key";
DROP INDEX IF EXISTS "AgreementAcceptance_campaignId_key";

CREATE UNIQUE INDEX "AgreementAcceptance_platform_publisher_once" ON "AgreementAcceptance"("publisherId", "templateId")
  WHERE "publisherId" IS NOT NULL AND "attemptId" IS NULL AND "campaignId" IS NULL AND "packageSaleId" IS NULL AND "orderId" IS NULL;
CREATE UNIQUE INDEX "AgreementAcceptance_platform_advertiser_once" ON "AgreementAcceptance"("advertiserId", "templateId")
  WHERE "advertiserId" IS NOT NULL AND "attemptId" IS NULL AND "campaignId" IS NULL AND "packageSaleId" IS NULL AND "orderId" IS NULL;
CREATE UNIQUE INDEX "AgreementAcceptance_attempt_once" ON "AgreementAcceptance"("templateId", "attemptId") WHERE "attemptId" IS NOT NULL;
CREATE UNIQUE INDEX "AgreementAcceptance_campaign_once" ON "AgreementAcceptance"("templateId", "campaignId") WHERE "campaignId" IS NOT NULL;
CREATE UNIQUE INDEX "AgreementAcceptance_package_sale_once" ON "AgreementAcceptance"("templateId", "packageSaleId") WHERE "packageSaleId" IS NOT NULL;
CREATE UNIQUE INDEX "AgreementAcceptance_order_once" ON "AgreementAcceptance"("templateId", "orderId") WHERE "orderId" IS NOT NULL;
CREATE INDEX "AgreementAcceptance_agentId_templateKind_idx" ON "AgreementAcceptance"("agentId", "templateKind");
CREATE INDEX "AgreementAcceptance_campaignId_idx" ON "AgreementAcceptance"("campaignId");
CREATE INDEX "AgreementAcceptance_attemptId_idx" ON "AgreementAcceptance"("attemptId");
CREATE INDEX "AgreementAcceptance_packageSaleId_idx" ON "AgreementAcceptance"("packageSaleId");
CREATE INDEX "AgreementAcceptance_orderId_idx" ON "AgreementAcceptance"("orderId");
ALTER TABLE "AgreementAcceptance" ADD CONSTRAINT "AgreementAcceptance_one_party"
  CHECK ((("publisherId" IS NOT NULL)::int + ("advertiserId" IS NOT NULL)::int + ("agentId" IS NOT NULL)::int) = 1);
