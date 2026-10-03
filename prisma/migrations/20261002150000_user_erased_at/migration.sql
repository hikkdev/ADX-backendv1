-- Account lifecycle (2 Oct 2026): "Erased" is its own state. An erasure
-- anonymises the person and keeps the ledger, invoices, agreements and KYC
-- decision rows; this stamps the moment it was carried out, so the users
-- directory can show the Erased facet beside Closed. Additive only — every
-- existing row reads null (not erased).
ALTER TABLE "User" ADD COLUMN "erasedAt" TIMESTAMP(3);
