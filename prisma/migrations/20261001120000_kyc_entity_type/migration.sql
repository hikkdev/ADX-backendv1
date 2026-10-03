-- Phase D (the owner, 1 Oct 2026): Digio KYC by entity type.
--
-- Digio holds 25 KYC workflows, one per party and legal form, and a request
-- must name the right one — so the party rows learn what legal form they
-- verify as. Nullable: an account that has not been asked yet is null, and
-- the KYC start asks (or reads it off the legacy `type` where that settles
-- it — INDIVIDUAL, NGO, POLITICAL). Agents and employees get no column.
CREATE TYPE "KycEntityType" AS ENUM (
  'INDIVIDUAL',
  'SOLE_PROPRIETOR',
  'COMPANY',
  'LLP_PARTNERSHIP',
  'NON_PROFIT',
  'GOVERNMENT_EDUCATION',
  'OTHER_ENTITY',
  'POLITICAL'
);

ALTER TABLE "Publisher" ADD COLUMN "entityType" "KycEntityType";
ALTER TABLE "Advertiser" ADD COLUMN "entityType" "KycEntityType";
ALTER TABLE "PrintPartner" ADD COLUMN "entityType" "KycEntityType";

-- The Digio webhook finds a publisher's row by Digio's request id; the other
-- four KYC tables were indexed on it, this one was not.
CREATE INDEX "PublisherKyc_digioRequestId_idx" ON "PublisherKyc"("digioRequestId");
